import { LINE_ITEM_CLASSIFICATIONS } from '../constants/lineItemRouting.js';
import { buildOrderFactoryIdentity } from './factoryFileNames.js';
import { validateShopifyShippingAddress } from '../services/PreflightValidationService.js';
import { resolveFactoryFinancialData } from '../services/FactoryFinancialDataService.js';

export function xmlEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseJsonIfNeeded(value) {
  if (value === null || value === undefined || typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function formatMm(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return '';
  }

  if (Number.isInteger(numberValue)) {
    return String(numberValue);
  }

  return String(Number(numberValue.toFixed(3)));
}

function getShippingFrom() {
  return {
    company: 'Wandini',
    contactPerson: 'Wandini',
    street: 'Rheinstrasse 12',
    postcode: '41836',
    city: 'Hückelhoven',
    country: 'DE',
  };
}

function getShippingTo(rawPayload) {
  const validation = validateShopifyShippingAddress(rawPayload);

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  return validation.normalized;
}

function getCustomerEmail(rawPayload) {
  for (const value of [rawPayload.email, rawPayload.contact_email, rawPayload.customer?.email]) {
    if (typeof value !== 'string') continue;
    const email = value.trim();
    const parts = email.split('@');
    if (email.length > 254 || parts.length !== 2 || parts[0].length > 64) continue;
    const [local, domain] = parts;
    if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)) continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) continue;
    return email;
  }

  throw new Error('Valid customer email is required for NEXO XML');
}

function getGeneratedPanels(panelFiles) {
  if (!Array.isArray(panelFiles) || panelFiles.length === 0) {
    throw new Error('Generated panel PDFs are required for NEXO XML');
  }

  const panels = panelFiles.map((panelFile, index) => {
    const panelNumber = index + 1;
    const fileName = normalizeText(panelFile?.fileName);
    const widthMm = Number(panelFile?.widthMm);
    const heightMm = Number(panelFile?.heightMm);

    if (!fileName || !/\.pdf$/i.test(fileName)) {
      throw new Error(
        `Generated panel ${panelNumber} must have a PDF filename for NEXO XML`
      );
    }

    if (!Number.isFinite(widthMm) || widthMm <= 0) {
      throw new Error(
        `Generated panel ${panelNumber} width must be a positive number`
      );
    }

    if (!Number.isFinite(heightMm) || heightMm <= 0) {
      throw new Error(
        `Generated panel ${panelNumber} height must be a positive number`
      );
    }

    return { fileName, widthMm, heightMm };
  });
  const uniqueFileNames = new Set(panels.map((panel) => panel.fileName));

  if (uniqueFileNames.size !== panels.length) {
    throw new Error('Generated panel PDF filenames must be unique for NEXO XML');
  }

  const firstPanel = panels[0];
  const mismatchedPanel = panels.find(
    (panel) =>
      Math.abs(panel.widthMm - firstPanel.widthMm) > 0.001 ||
      Math.abs(panel.heightMm - firstPanel.heightMm) > 0.001
  );

  if (mismatchedPanel) {
    throw new Error(
      `Generated panel dimensions must match for one-position NEXO XML: ${mismatchedPanel.fileName}`
    );
  }

  return panels;
}

// Identity is the pair (Shopify line ID, source position), never the SKU or
// the caller's array order. Return a new array in Shopify's original order.
export function matchFactoryFinancialPositions(positions, financialData) {
  const invalid = () => {
    const error = new Error('factory_financial_position_mismatch');
    error.code = 'factory_financial_position_mismatch';
    throw error;
  };
  if (!Array.isArray(positions) || positions.length !== financialData.positions.length) invalid();
  const byIdentity = new Map();
  for (const position of positions) {
    const id = position?.shopifyLineItemId;
    if ((typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) &&
        (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) invalid();
    if (!Number.isSafeInteger(position.sourcePosition) || position.sourcePosition < 0 ||
        ![LINE_ITEM_CLASSIFICATIONS.WALLPAPER, LINE_ITEM_CLASSIFICATIONS.ACCESSORY].includes(position.classification)) invalid();
    const key = `${id}:${position.sourcePosition}`;
    if (byIdentity.has(key)) invalid();
    byIdentity.set(key, position);
  }
  return financialData.positions.map(financial => {
    const position = byIdentity.get(`${financial.shopifyLineItemId}:${financial.sourcePosition}`);
    if (!position || position.sku !== financial.sku || position.quantity !== financial.quantity ||
        (position.classification === LINE_ITEM_CLASSIFICATIONS.WALLPAPER && position.quantity !== 1)) invalid();
    return { ...position, totalPrice: financial.totalPrice };
  });
}

function buildPositionXml(position, index) {
  const sku = normalizeText(position?.sku);
  if (!sku) {
    throw new Error(`Factory position ${index + 1} requires a non-empty SKU`);
  }

  if (position?.classification === LINE_ITEM_CLASSIFICATIONS.ACCESSORY) {
    const quantity = position.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error('Accessory quantity must be a positive integer');
    }
    if (
      !Array.isArray(position.panelFiles) || position.panelFiles.length !== 0
    ) {
      throw new Error('Accessory positions must not contain panel files');
    }
    return `    <position>
      <sku>${xmlEscape(sku)}</sku>
      <width unit="mm">0</width>
      <height unit="mm">0</height>
      <variants>1</variants>
      <copies_per_variant>${quantity}</copies_per_variant>
      <total_price>${xmlEscape(position.totalPrice)}</total_price>
      <files/>
    </position>`;
  }

  if (
    position.classification !== LINE_ITEM_CLASSIFICATIONS.WALLPAPER
  ) {
    throw new Error('Unknown factory position classification');
  }
  const panels = getGeneratedPanels(position?.panelFiles);
  const firstPanel = panels[0];
  const fileItems = panels
    .map(
      (panel) =>
        `        <file type="ftp">${xmlEscape(panel.fileName)}</file>`
    )
    .join('\n');

  return `    <position>
      <sku>${xmlEscape(sku)}</sku>
      <width unit="mm">${xmlEscape(formatMm(firstPanel.widthMm))}</width>
      <height unit="mm">${xmlEscape(formatMm(firstPanel.heightMm))}</height>
      <variants>${xmlEscape(panels.length)}</variants>
      <copies_per_variant>1</copies_per_variant>
      <total_price>${xmlEscape(position.totalPrice)}</total_price>
      <files>
${fileItems}
      </files>
    </position>`;
}

export function buildOrderXml({ order, shopifyOrderId, positions }) {
  const rawPayload = parseJsonIfNeeded(order?.raw_payload_json);

  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('Shopify order payload is required for NEXO XML');
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    throw new Error('At least one factory position is required for NEXO XML');
  }

  const positionFileNames = positions.flatMap((position) =>
    (Array.isArray(position?.panelFiles) ? position.panelFiles : []).map(
      (panel) => normalizeText(panel?.fileName)
    )
  );

  if (new Set(positionFileNames).size !== positionFileNames.length) {
    throw new Error('Wallpaper PDF filenames must be unique across positions');
  }

  const orderNumber = buildOrderFactoryIdentity(shopifyOrderId);
  const shippingFrom = getShippingFrom();
  const shippingTo = getShippingTo(rawPayload);
  const customerEmail = getCustomerEmail(rawPayload);
  const financialData = resolveFactoryFinancialData(order.raw_payload_json);
  if (String(rawPayload.id) !== String(shopifyOrderId) ||
      (order.shopify_order_id !== undefined && String(order.shopify_order_id) !== String(shopifyOrderId))) {
    const error = new Error('factory_financial_order_identity_mismatch');
    error.code = 'factory_financial_order_identity_mismatch';
    throw error;
  }
  const positionsXml = matchFactoryFinancialPositions(positions, financialData)
    .map((position, index) => buildPositionXml(position, index))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>${xmlEscape(orderNumber)}</order_number>
    <shipping_type>Standard</shipping_type>
    <shipping_costs>${xmlEscape(financialData.shippingCosts)}</shipping_costs>
    <payment_method>${xmlEscape(financialData.paymentMethod)}</payment_method>
    <shipping_from>
      <company>${xmlEscape(shippingFrom.company)}</company>
      <contact_person>${xmlEscape(shippingFrom.contactPerson)}</contact_person>
      <street>${xmlEscape(shippingFrom.street)}</street>
      <postcode>${xmlEscape(shippingFrom.postcode)}</postcode>
      <city>${xmlEscape(shippingFrom.city)}</city>
      <country>${xmlEscape(shippingFrom.country)}</country>
    </shipping_from>
    <shipping_to>
      <company>${xmlEscape(shippingTo.company)}</company>
      <contact_person>${xmlEscape(shippingTo.contactPerson)}</contact_person>
      <street>${xmlEscape(shippingTo.street)}</street>
      <postcode>${xmlEscape(shippingTo.postcode)}</postcode>
      <city>${xmlEscape(shippingTo.city)}</city>
      <country>${xmlEscape(shippingTo.country)}</country>
      <phone>${xmlEscape(shippingTo.phone)}</phone>
      <email>${xmlEscape(customerEmail)}</email>
    </shipping_to>
  </order>
  <positions>
${positionsXml}
  </positions>
</root>`;
}

export default {
  xmlEscape,
  buildOrderXml,
};

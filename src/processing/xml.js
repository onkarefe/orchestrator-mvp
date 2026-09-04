import { buildOrderFactoryIdentity } from './factoryFileNames.js';

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

function isAddress(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).some((field) => normalizeText(field))
  );
}

function getShippingAddress(rawPayload) {
  return [
    rawPayload?.shipping_address,
    rawPayload?.billing_address,
    rawPayload?.customer?.default_address,
  ].find(isAddress) ?? {};
}

function getAddressFullName(address) {
  return [address?.first_name, address?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function getShippingTo(rawPayload) {
  const address = getShippingAddress(rawPayload);
  const fullName = getAddressFullName(address);
  const company =
    normalizeText(address.company) || normalizeText(address.name) || fullName;
  const contactPerson =
    normalizeText(address.name) || fullName || company;
  const shippingTo = {
    company,
    contactPerson,
    street: [address.address1, address.address2]
      .map(normalizeText)
      .filter(Boolean)
      .join(', '),
    postcode: normalizeText(address.zip),
    city: normalizeText(address.city),
    country: normalizeText(address.country_code),
    phone:
      normalizeText(address.phone) ||
      normalizeText(rawPayload?.phone) ||
      normalizeText(rawPayload?.customer?.phone) ||
      '0000',
  };
  const requiredFields = {
    company: shippingTo.company,
    contact_person: shippingTo.contactPerson,
    street: shippingTo.street,
    postcode: shippingTo.postcode,
    city: shippingTo.city,
    country: shippingTo.country,
  };
  const missingFields = Object.entries(requiredFields)
    .filter(([, value]) => !value)
    .map(([field]) => field);

  if (missingFields.length > 0) {
    throw new Error(
      `Required NEXO shipping_to fields are missing: ${missingFields.join(', ')}`
    );
  }

  return shippingTo;
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

function buildPositionXml(position, index) {
  const sku = normalizeText(position?.sku);
  const copiesPerVariant = Number(position?.quantity);
  const panels = getGeneratedPanels(position?.panelFiles);

  if (!sku) {
    throw new Error(`Wallpaper position ${index + 1} requires a non-empty SKU`);
  }

  if (!Number.isSafeInteger(copiesPerVariant) || copiesPerVariant <= 0) {
    throw new Error(
      `Wallpaper position ${index + 1} quantity must be a positive integer`
    );
  }

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
      <copies_per_variant>${xmlEscape(copiesPerVariant)}</copies_per_variant>
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
    throw new Error('At least one wallpaper position is required for NEXO XML');
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
  const positionsXml = positions
    .map((position, index) => buildPositionXml(position, index))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>${xmlEscape(orderNumber)}</order_number>
    <shipping_type>Standard</shipping_type>
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

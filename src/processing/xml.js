import env from '../config/env.js';
import { buildFactoryReference } from '../utils/factoryReference.js';

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

function getShippingType(rawPayload) {
  const shippingLine = Array.isArray(rawPayload?.shipping_lines)
    ? rawPayload.shipping_lines[0]
    : null;

  return (
    normalizeText(shippingLine?.code) ||
    normalizeText(shippingLine?.title) ||
    'Standard'
  );
}

function getShippingFrom() {
  return {
    company: env.NEXO_SHIPPING_FROM_COMPANY,
    contactPerson: env.NEXO_SHIPPING_FROM_CONTACT_PERSON,
    street: env.NEXO_SHIPPING_FROM_STREET,
    postcode: env.NEXO_SHIPPING_FROM_POSTCODE,
    city: env.NEXO_SHIPPING_FROM_CITY,
    country: env.NEXO_SHIPPING_FROM_COUNTRY,
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

function getFirstPanel(panelFiles) {
  const firstPanel = Array.isArray(panelFiles) ? panelFiles[0] : null;
  const fileName = firstPanel?.fileName;
  const widthMm = Number(firstPanel?.widthMm);
  const heightMm = Number(firstPanel?.heightMm);

  if (!fileName) {
    throw new Error('First generated panel PDF is required for NEXO XML');
  }

  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    throw new Error('First generated panel width must be a positive number');
  }

  if (!Number.isFinite(heightMm) || heightMm <= 0) {
    throw new Error('First generated panel height must be a positive number');
  }

  return { fileName, widthMm, heightMm };
}

function buildPositionXml(panel) {
  return `    <position>
      <sku>${xmlEscape(env.NEXO_PRODUCT_SKU)}</sku>
      <width unit="mm">${xmlEscape(formatMm(panel.widthMm))}</width>
      <height unit="mm">${xmlEscape(formatMm(panel.heightMm))}</height>
      <variants>1</variants>
      <copies_per_variant>1</copies_per_variant>
      <files>
        <file type="ftp">${xmlEscape(panel.fileName)}</file>
      </files>
    </position>`;
}

export function buildOrderXml({ order, job, shopifyOrderId, panelFiles }) {
  const rawPayload = parseJsonIfNeeded(order?.raw_payload_json);

  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('Shopify order payload is required for NEXO XML');
  }

  const factoryReference = buildFactoryReference({
    shopifyOrderId,
    jobId: job?.id,
  });
  const shippingFrom = getShippingFrom();
  const shippingTo = getShippingTo(rawPayload);
  const firstPanel = getFirstPanel(panelFiles);
  const positionXml = buildPositionXml(firstPanel);

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>${xmlEscape(factoryReference)}</order_number>
    <reference>${xmlEscape(factoryReference)}</reference>
    <shipping_type>${xmlEscape(getShippingType(rawPayload))}</shipping_type>
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
${positionXml}
  </positions>
</root>`;
}

export default {
  xmlEscape,
  buildOrderXml,
};

import env from '../config/env.js';
import { buildFactoryReference } from '../utils/factoryReference.js';

const NEXO_DEMO_SHIPPING_FROM = Object.freeze({
  company: 'Werbeagentur XY GmbH',
  contactPerson: '',
  street: 'Musterstr. 4',
  postcode: '12345',
  city: 'Musterstadt',
  country: 'DE',
});

const NEXO_DEMO_SHIPPING_TO = Object.freeze({
  company: 'Musterkunde AG',
  contactPerson: 'Martina Musterfrau',
  street: 'Testweg 45',
  postcode: '54321',
  city: 'Testhausen',
  country: 'DE',
  phone: '01234-567890',
});

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

export function buildOrderXml({ job, shopifyOrderId, panelFiles }) {
  const factoryReference = buildFactoryReference({
    shopifyOrderId,
    jobId: job?.id,
  });
  const firstPanel = getFirstPanel(panelFiles);
  const positionXml = buildPositionXml(firstPanel);

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>${xmlEscape(factoryReference)}</order_number>
    <reference>${xmlEscape(factoryReference)}</reference>
    <shipping_type>Standard</shipping_type>
    <shipping_from>
      <company>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.company)}</company>
      <contact_person>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.contactPerson)}</contact_person>
      <street>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.street)}</street>
      <postcode>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.postcode)}</postcode>
      <city>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.city)}</city>
      <country>${xmlEscape(NEXO_DEMO_SHIPPING_FROM.country)}</country>
    </shipping_from>
    <shipping_to>
      <company>${xmlEscape(NEXO_DEMO_SHIPPING_TO.company)}</company>
      <contact_person>${xmlEscape(NEXO_DEMO_SHIPPING_TO.contactPerson)}</contact_person>
      <street>${xmlEscape(NEXO_DEMO_SHIPPING_TO.street)}</street>
      <postcode>${xmlEscape(NEXO_DEMO_SHIPPING_TO.postcode)}</postcode>
      <city>${xmlEscape(NEXO_DEMO_SHIPPING_TO.city)}</city>
      <country>${xmlEscape(NEXO_DEMO_SHIPPING_TO.country)}</country>
      <phone>${xmlEscape(NEXO_DEMO_SHIPPING_TO.phone)}</phone>
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

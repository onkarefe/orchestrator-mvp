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

function getCustomerFullName(rawPayload) {
  const firstName = rawPayload?.customer?.first_name ?? '';
  const lastName = rawPayload?.customer?.last_name ?? '';

  return `${firstName} ${lastName}`.trim() || rawPayload?.customer?.name || '';
}

function getShippingType(rawPayload) {
  const shippingLine = Array.isArray(rawPayload?.shipping_lines)
    ? rawPayload.shipping_lines[0]
    : null;
  const shippingMethod = shippingLine?.code || shippingLine?.title;

  return ['Standard', '24h Express', '48h Express'].includes(shippingMethod)
    ? shippingMethod
    : 'Standard';
}

function getShippingFrom() {
  return {
    company: process.env.FACTORY_SHIPPING_FROM_COMPANY || 'TO_BE_AGREED',
    contactPerson:
      process.env.FACTORY_SHIPPING_FROM_CONTACT_PERSON || 'TO_BE_AGREED',
    street: process.env.FACTORY_SHIPPING_FROM_STREET || 'TO_BE_AGREED',
    postcode: process.env.FACTORY_SHIPPING_FROM_POSTCODE || '00000',
    city: process.env.FACTORY_SHIPPING_FROM_CITY || 'TO_BE_AGREED',
    country: process.env.FACTORY_SHIPPING_FROM_COUNTRY || 'DE',
  };
}

function getShippingTo(rawPayload) {
  const address =
    rawPayload?.shipping_address ??
    rawPayload?.billing_address ??
    rawPayload?.customer?.default_address ??
    {};
  const customerFullName = getCustomerFullName(rawPayload);
  const company =
    address.company || address.name || customerFullName || 'Private Customer';

  return {
    company,
    contactPerson: address.name || customerFullName || company,
    street: [address.address1, address.address2].filter(Boolean).join(' ').trim(),
    postcode: address.zip || '00000',
    city: address.city || 'Unknown',
    country: address.country_code || 'DE',
    phone:
      address.phone ||
      rawPayload?.customer?.phone ||
      rawPayload?.phone ||
      '0000',
  };
}

function getSku(rawPayload, job) {
  const lineItems = Array.isArray(rawPayload?.line_items)
    ? rawPayload.line_items
    : [];
  const lineItemId = job?.shopify_line_item_id;
  const lineItem =
    lineItemId === null || lineItemId === undefined
      ? null
      : lineItems.find((item) => String(item?.id) === String(lineItemId));

  return lineItem?.sku || 'MISSING-SKU';
}

function normalizePanelFiles(panelFiles, job) {
  if (!Array.isArray(panelFiles)) {
    return [];
  }

  return panelFiles
    .map((panelFile) => {
      if (!panelFile) {
        return null;
      }

      if (typeof panelFile === 'string') {
        return {
          fileName: panelFile,
          widthMm: Number(job?.width_mm),
          heightMm: Number(job?.height_mm),
        };
      }

      return {
        fileName: panelFile.fileName,
        widthMm: Number(panelFile.widthMm),
        heightMm: Number(panelFile.heightMm),
      };
    })
    .filter((panelFile) => panelFile?.fileName);
}

function groupPanelFilesByDimensions(panelFiles) {
  const groups = [];

  for (const panelFile of panelFiles) {
    const widthMm = Number(panelFile.widthMm);
    const heightMm = Number(panelFile.heightMm);

    const lastGroup = groups[groups.length - 1];
    const sameAsLast =
      lastGroup &&
      Math.abs(lastGroup.widthMm - widthMm) < 0.000001 &&
      Math.abs(lastGroup.heightMm - heightMm) < 0.000001;

    if (sameAsLast) {
      lastGroup.files.push(panelFile.fileName);
      continue;
    }

    groups.push({
      widthMm,
      heightMm,
      files: [panelFile.fileName],
    });
  }

  return groups;
}

function buildPositionsXml(rawPayload, job, panelFiles) {
  const sku = getSku(rawPayload, job);
  const normalizedPanelFiles = normalizePanelFiles(panelFiles, job);
  const groupedPositions = groupPanelFilesByDimensions(normalizedPanelFiles);

  return groupedPositions
    .map((position) => {
      const fileItems = position.files
        .map(
          (fileName) =>
            `        <file type="ftp">${xmlEscape(fileName)}</file>`
        )
        .join('\n');

      return `    <position>
      <sku>${xmlEscape(sku)}</sku>
      <width unit="mm">${xmlEscape(formatMm(position.widthMm))}</width>
      <height unit="mm">${xmlEscape(formatMm(position.heightMm))}</height>
      <variants>${xmlEscape(position.files.length)}</variants>
      <copies_per_variant>1</copies_per_variant>
      <files>
${fileItems}
      </files>
    </position>`;
    })
    .join('\n');
}

export function buildOrderXml({ order, job, shopifyOrderId, panelFiles }) {
  const rawPayload = parseJsonIfNeeded(order?.raw_payload_json) ?? {};
  const shippingFrom = getShippingFrom();
  const shippingTo = getShippingTo(rawPayload);
  const reference =
    rawPayload.name || order?.shopify_order_number || shopifyOrderId;

  const positionsXml = buildPositionsXml(rawPayload, job, panelFiles);

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>WANDINI-${xmlEscape(shopifyOrderId)}</order_number>
    <reference>${xmlEscape(reference)}</reference>
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
${positionsXml}
  </positions>
</root>`;
}

export default {
  xmlEscape,
  buildOrderXml,
};
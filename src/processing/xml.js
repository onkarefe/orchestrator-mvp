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

export function buildOrderXml({ order, job, panelInfo, panelFiles }) {
  const files = Array.isArray(panelFiles) ? panelFiles : [];

  const fileItems = files
    .map((fileName) => `    <file>${xmlEscape(fileName)}</file>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<order>
  <order_number>${xmlEscape(order?.shopify_order_number)}</order_number>
  <shopify_order_id>${xmlEscape(order?.shopify_order_id)}</shopify_order_id>
  <customer_name>${xmlEscape(order?.customer_name)}</customer_name>
  <sku>${xmlEscape(job?.sku)}</sku>
  <width_mm>${xmlEscape(job?.width_mm)}</width_mm>
  <height_mm>${xmlEscape(job?.height_mm)}</height_mm>
  <panel_count>${xmlEscape(panelInfo?.panelCount)}</panel_count>
  <panel_width_cm>${xmlEscape(panelInfo?.panelWidthCm)}</panel_width_cm>
  <files>
${fileItems}
  </files>
</order>`;
}

export default {
  xmlEscape,
  buildOrderXml,
};

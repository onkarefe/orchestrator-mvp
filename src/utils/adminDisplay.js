import { redact, isSensitiveKey, redactSensitiveText } from './redact.js';
const timestampFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
});
export function formatAdminTimestamp(value) {
  if (value === null || value === undefined || value === '') return '\u2014';
  if (!(value instanceof Date) && typeof value !== 'string') return '\u2014';
  // Preserve mysql2's existing interpretation of DB dates. Only display changes.
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? timestampFormatter.format(date) : '\u2014';
}
export const display = value => value === null || value === undefined || value === '' ? '\u2014' : redactSensitiveText(value);
export const statusLabel = value => String(display(value)).replaceAll('_', ' ');
export const booleanLabel = value => value === null || value === undefined ? 'Not checked'
  : value === true || value === 1 || value === '1' ? 'Valid' : 'Invalid';
const tones = {
  success: ['pass', 'completed', 'processed', 'available', 'uploaded', 'ready', 'valid', 'validated', 'success', 'artifact_ready', 'artifact_generated', 'production_completed', 'ready_for_shipping', 'shipped', 'production_ready'],
  info: ['received', 'processing', 'pending', 'queued', 'recorded', 'uploading', 'validating', 'factory_received', 'production_started', 'info'],
  warning: ['manual_review', 'retrying', 'stale', 'warning', 'warn', 'blocked'],
  critical: ['fail', 'security_hold', 'failed', 'invalid', 'invalid_hmac', 'error', 'critical', 'rejected'],
};
export function statusClass(value) {
  const statuses = String(value ?? '').toLowerCase().split(',').map(s => s.trim());
  for (const tone of ['critical', 'warning', 'info', 'success']) {
    if (statuses.some(s => tones[tone].includes(s))) return 'status-' + tone;
  }
  return 'status-neutral';
}
export function checkoutSecurity(order = {}) {
  let value = order.checkout_security_json;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const security = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    result: security.result === 'NOT_APPLICABLE' ? 'N/A' : security.result || 'Not checked',
    mode: security.mode, reason: security.reason, detectedAt: security.detectedAt,
    sourceName: security.sourceName, proofDigest: security.proofDigest ? 'PRESENT' : 'MISSING',
    held: order.status === 'SECURITY_HOLD',
  };
}
// Admin presentation only: also redact Shopify name/value proof attributes.
export function adminJson(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return '[unparseable_json_string]'; }
  }
  const sensitive = key => isSensitiveKey(key) || /proof|signature|hmac/i.test(key);
  const clean = item => {
    if (!item || typeof item !== 'object') return item;
    if (item instanceof Date) return item.toJSON();
    if (Array.isArray(item)) return item.map(clean);
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      sensitive(key) || (key === 'value' && sensitive(String(item.name ?? item.key ?? '')))
        ? '[REDACTED]' : clean(child)]));
  };
  return JSON.stringify(clean(redact(value ?? {})), null, 2);
}
export default { display, date: formatAdminTimestamp, statusClass, statusLabel, booleanLabel, security: checkoutSecurity, json: adminJson };

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import env from '../config/env.js';
import { classifyShopifyLineItem } from './LineItemRoutingService.js';
import { resolveConfiguratorProperties } from './ConfiguratorPropertyResolver.js';
import { LINE_ITEM_CLASSIFICATIONS } from '../constants/lineItemRouting.js';

export const CHECKOUT_FIELDS = Object.freeze({
  version: 'wandini_checkout_proof_version',
  proof: 'wandini_checkout_proof',
  signature: 'wandini_checkout_signature',
});

const fail = (reason) => { throw new Error(reason); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// JSON keys use UTF-16 code-unit order. Arrays retain their semantic order.
// Only the proof's configured-line array is sorted, by stable instance identity.
export function canonicalJson(value, depth = 0) {
  if (depth > 32) fail('CHECKOUT_PROOF_MALFORMED');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort(compare).map(key =>
      JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1)
    ).join(',') + '}';
  }
  fail('CHECKOUT_PROOF_MALFORMED');
}

export function canonicalMoney(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 64) {
    fail('CHECKOUT_PRICE_MISMATCH');
  }
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function identity(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('CHECKOUT_LINE_MISMATCH');
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) fail('CHECKOUT_LINE_MISMATCH');
  return text;
}

function instanceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value)) {
    fail('CHECKOUT_LINE_MISMATCH');
  }
  return value;
}

export function canonicalCheckoutProof(proof) {
  if (!proof || proof.version !== '1' || !Array.isArray(proof.lines) || proof.lines.length > 100) {
    fail('CHECKOUT_PROOF_MALFORMED');
  }
  const ids = proof.lines.map(line => instanceId(line?.configurator_instance_id));
  if (new Set(ids).size !== ids.length) fail('CHECKOUT_DUPLICATE_INSTANCE');
  return canonicalJson({ ...proof, lines: [...proof.lines].sort((a, b) =>
    compare(a.configurator_instance_id, b.configurator_instance_id)) });
}

function configuredLines(payload, config) {
  return (Array.isArray(payload?.line_items) ? payload.line_items : []).filter(line => {
    const routing = classifyShopifyLineItem(line, {
      wallpaperSkus: config.WALLPAPER_SKUS,
      validationOptions: { checkMasterFileExists: false },
    });
    // UNKNOWN with an existing configurator marker is already factory-blocked
    // by routing; it must not be reported as an ordinary checkout either.
    return routing.classification === LINE_ITEM_CLASSIFICATIONS.WALLPAPER ||
      resolveConfiguratorProperties(line?.properties).hasMarker;
  });
}

function lineProof(line, currency, shopCurrency) {
  const resolved = resolveConfiguratorProperties(line.properties);
  for (const name of ['_configurator_payload', 'configurator_payload', '_configurator_instance_id', 'configurator_instance_id']) {
    if (line.properties.filter(p => p?.name === name).length > 1) fail('CHECKOUT_LINE_MISMATCH');
  }
  const payload = typeof resolved.payload === 'string' ? JSON.parse(resolved.payload) : resolved.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('CHECKOUT_LINE_MISMATCH');
  const instance = instanceId(resolved.instanceId);
  if (payload.configurator_instance_id !== undefined && payload.configurator_instance_id !== instance) {
    fail('CHECKOUT_LINE_MISMATCH');
  }
  if (typeof payload.master_asset_id !== 'string' || !payload.master_asset_id.trim() ||
      payload.output?.unit !== 'mm' ||
      ![payload.output.width, payload.output.height].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) ||
      line.quantity !== 1 || typeof line.sku !== 'string' || !line.sku.trim()) {
    fail('CHECKOUT_LINE_MISMATCH');
  }
  // Server-calculated pre-discount Draft priceOverride in checkout currency.
  // Shopify discounts do not change this signed unit-price contract.
  const money = line.price_set?.presentment_money;
  const shopMoney = line.price_set?.shop_money;
  if (!shopMoney || shopMoney.currency_code !== shopCurrency) fail('CHECKOUT_CURRENCY_MISMATCH');
  if (canonicalMoney(line.price) !== canonicalMoney(shopMoney.amount) ||
      (shopCurrency === currency && canonicalMoney(shopMoney.amount) !== canonicalMoney(money?.amount))) {
    fail('CHECKOUT_PRICE_MISMATCH');
  }
  if (!money || money.currency_code !== currency) fail('CHECKOUT_CURRENCY_MISMATCH');
  return {
    configurator_instance_id: instance,
    variant_id: identity(line.variant_id),
    sku: line.sku.trim(),
    quantity: 1,
    master_asset_id: payload.master_asset_id.trim(),
    output: { width: payload.output.width, height: payload.output.height, unit: 'mm' },
    payload_sha256: sha256(canonicalJson(payload)),
    price: canonicalMoney(money.amount),
    currency,
  };
}

// Exposed as a contract helper/test vector builder. The future signer must
// supply trusted server-resolved values, never sign a client payload blindly.
export function buildCheckoutProof(payload, config = env) {
  const currency = payload.presentment_currency ?? payload.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail('CHECKOUT_CURRENCY_MISMATCH');
  const lines = configuredLines(payload, config);
  const identities = lines.map(line => identity(line.id));
  if (new Set(identities).size !== identities.length) fail('CHECKOUT_LINE_MISMATCH');
  const proof = { version: '1', lines: lines.map(line => lineProof(line, currency, payload.currency)) };
  return JSON.parse(canonicalCheckoutProof(proof));
}

export function evaluateCheckoutSecurity(payload, config = env) {
  const lines = configuredLines(payload, config);
  if (lines.length === 0) return { result: 'NOT_APPLICABLE', reason: null, instanceIds: [] };
  const instanceIds = lines.map(line => resolveConfiguratorProperties(line?.properties).instanceId)
    .filter(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value));
  const result = (status, reason, extra = {}) => ({ result: status, reason, instanceIds, ...extra });
  try {
    const attributes = Array.isArray(payload.note_attributes) ? payload.note_attributes : [];
    const get = name => {
      const matches = attributes.filter(a => a?.name === name);
      if (matches.length > 1) fail('CHECKOUT_PROOF_MALFORMED');
      return matches[0]?.value;
    };
    const raw = get(CHECKOUT_FIELDS.proof);
    const signature = get(CHECKOUT_FIELDS.signature);
    const version = get(CHECKOUT_FIELDS.version);
    if (!raw) return result('FAIL', 'CHECKOUT_PROOF_MISSING');
    if (!signature) return result('FAIL', 'CHECKOUT_SIGNATURE_MISSING');
    if (version !== '1') return result('FAIL', 'CHECKOUT_PROOF_VERSION_UNSUPPORTED');
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 65536) fail('CHECKOUT_PROOF_MALFORMED');
    const proof = JSON.parse(raw);
    if (proof?.version !== '1') return result('FAIL', 'CHECKOUT_PROOF_VERSION_UNSUPPORTED');
    const canonical = canonicalCheckoutProof(proof);
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
      return result('FAIL', 'CHECKOUT_SIGNATURE_INVALID');
    }
    const secret = config.WANDINI_CHECKOUT_HMAC_SECRET;
    if (typeof secret !== 'string' || !secret.trim()) return result('FAIL', 'CHECKOUT_SECRET_UNAVAILABLE');
    const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return result('FAIL', 'CHECKOUT_SIGNATURE_INVALID');
    const actual = buildCheckoutProof(payload, config);
    if (proof.lines.length !== actual.lines.length) return result('FAIL', 'CHECKOUT_LINE_MISMATCH');
    const signed = JSON.parse(canonical);
    for (const [index, line] of actual.lines.entries()) {
      if (signed.lines[index].currency !== line.currency) return result('FAIL', 'CHECKOUT_CURRENCY_MISMATCH');
      if (signed.lines[index].price !== line.price) return result('FAIL', 'CHECKOUT_PRICE_MISMATCH');
    }
    if (canonical !== canonicalCheckoutProof(actual)) return result('FAIL', 'CHECKOUT_LINE_MISMATCH');
    return result('PASS', null, { proofDigest: sha256(canonical) });
  } catch (error) {
    const allowed = ['CHECKOUT_PROOF_MALFORMED', 'CHECKOUT_LINE_MISMATCH', 'CHECKOUT_PRICE_MISMATCH', 'CHECKOUT_CURRENCY_MISMATCH', 'CHECKOUT_DUPLICATE_INSTANCE'];
    return result('FAIL', allowed.includes(error?.message) ? error.message : 'CHECKOUT_PROOF_MALFORMED');
  }
}

export function checkoutGateMode(config = env) {
  const mode = config.CHECKOUT_SECURITY_GATE_MODE ?? 'off';
  if (!['off', 'report', 'enforce'].includes(mode)) throw new Error('CHECKOUT_SECURITY_GATE_MODE_INVALID');
  return mode;
}

export function isSecurityHeld(order) {
  return order?.status === 'SECURITY_HOLD';
}

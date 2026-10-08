// Standalone resolver for persisted Shopify REST/webhook order payloads.
// No catalog, checkout-proof, classification or factory-package dependencies.
const has = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, field) {
  // Field paths are constructed here, never from customer-supplied values.
  const error = new Error(`${code}: ${field}`);
  error.code = code;
  throw error;
}

function cents(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    fail('FINANCIAL_INVALID_MONEY', field);
  }
  const [whole, fraction = ''] = String(value).split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (typeof value === 'number' && result > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('FINANCIAL_UNSAFE_MONEY_NUMBER', field);
  }
  return result;
}

function formatted(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function currency(value, field) {
  if (value !== 'EUR') fail('FINANCIAL_UNSUPPORTED_CURRENCY', field);
}

function moneySet(value, field) {
  if (!record(value) || !record(value.presentment_money)) {
    fail('FINANCIAL_INVALID_MONEY_SET', field);
  }
  currency(value.presentment_money.currency_code, `${field}.presentment_money.currency_code`);
  const result = cents(value.presentment_money.amount, `${field}.presentment_money.amount`);
  if (has(value, 'shop_money')) {
    if (!record(value.shop_money)) fail('FINANCIAL_INVALID_MONEY_SET', field);
    currency(value.shop_money.currency_code, `${field}.shop_money.currency_code`);
    if (cents(value.shop_money.amount, `${field}.shop_money.amount`) !== result) {
      fail('FINANCIAL_INCONSISTENT_MONEY', field);
    }
  }
  return result;
}

function amount(object, key, path, required = true) {
  const field = `${path}.${key}`;
  if (has(object, `${key}_set`)) {
    const result = moneySet(object[`${key}_set`], `${field}_set`);
    if (has(object, key) && cents(object[key], field) !== result) {
      fail('FINANCIAL_INCONSISTENT_MONEY', field);
    }
    return result;
  }
  if (has(object, key)) return cents(object[key], field);
  if (required) fail('FINANCIAL_MISSING_MONEY', field);
  return null;
}

function array(object, key, path, required = false) {
  if (!has(object, key) && !required) return [];
  if (!Array.isArray(object[key])) fail('FINANCIAL_INVALID_STRUCTURE', `${path}.${key}`);
  return object[key];
}

function identity(value, field) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) fail('FINANCIAL_INVALID_ID', field);
    return String(value);
  }
  // Large IDs must arrive as strings. Already-rounded numeric IDs cannot be recovered.
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    fail('FINANCIAL_INVALID_ID', field);
  }
  return value;
}

function provider(order) {
  const names = array(order, 'payment_gateway_names', 'order', true);
  if (!names.length) fail('FINANCIAL_MISSING_PAYMENT_PROVIDER', 'order.payment_gateway_names');
  const providers = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) {
      fail('FINANCIAL_MISSING_PAYMENT_PROVIDER', 'order.payment_gateway_names');
    }
    const normalized = name.trim().toLowerCase();
    const matches = [
      [normalized === 'shopify_payments', 'Shopify Payments'],
      [normalized.includes('paypal'), 'PayPal'],
      [normalized.includes('stripe'), 'Stripe'],
      [normalized.includes('mollie'), 'Mollie'],
    ].filter(([matched]) => matched);
    if (matches.length !== 1) fail('FINANCIAL_UNSUPPORTED_PAYMENT_PROVIDER', 'order.payment_gateway_names');
    providers.add(matches[0][1]);
  }
  if (providers.size !== 1) fail('FINANCIAL_MULTIPLE_PAYMENT_PROVIDERS', 'order.payment_gateway_names');
  return [...providers][0];
}

function tax(object, path, included) {
  let result = 0n;
  for (const [index, line] of array(object, 'tax_lines', path, !included).entries()) {
    if (!record(line)) fail('FINANCIAL_INVALID_STRUCTURE', `${path}.tax_lines[${index}]`);
    result += amount(line, 'price', `${path}.tax_lines[${index}]`);
  }
  return result;
}

function allocations(object, path, target, applications, usedApplications) {
  let total = 0n;
  const entries = array(object, 'discount_allocations', path);
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const field = `${path}.discount_allocations[${index}]`;
    if (!record(entry)) fail('FINANCIAL_INVALID_DISCOUNT', field);
    const value = amount(entry, 'amount', field);
    if (has(entry, 'discount_application_index')) {
      const applicationIndex = entry.discount_application_index;
      if (!Number.isSafeInteger(applicationIndex) || applicationIndex < 0 || seen.has(applicationIndex)) {
        fail('FINANCIAL_INVALID_DISCOUNT', field);
      }
      seen.add(applicationIndex);
      if (applications !== null) {
        const application = applications[applicationIndex];
        if (!application || application.target_type !== target) fail('FINANCIAL_INVALID_DISCOUNT', field);
        usedApplications.add(applicationIndex);
      }
    } else if (applications?.length) {
      fail('FINANCIAL_INVALID_DISCOUNT', field);
    }
    total += value;
  }
  return { total, count: entries.length };
}

function rejectUnsupported(order) {
  for (const key of ['refunds', 'returns']) {
    if (array(order, key, 'order').length) fail('FINANCIAL_UNSUPPORTED_REFUND_RETURN', `order.${key}`);
  }
  // Nullable duty/fee totals are Shopify's explicit "not applicable" representation.
  for (const key of [
    'total_tip_received', 'total_duties', 'original_total_duties', 'current_total_duties',
    'total_additional_fees', 'original_total_additional_fees', 'current_total_additional_fees',
    'total_cash_rounding_payment_adjustment', 'total_cash_rounding_refund_adjustment',
  ]) {
    if (order[key] === null && !has(order, `${key}_set`) && /duties|fees/.test(key)) continue;
    if (order[`${key}_set`] === null && !has(order, key) && /duties|fees/.test(key)) continue;
    const value = amount(order, key, 'order', false);
    if (value !== null && value !== 0n) fail('FINANCIAL_UNSUPPORTED_CHARGE', `order.${key}`);
  }
  for (const key of ['duties', 'additional_fees']) {
    if (array(order, key, 'order').length) fail('FINANCIAL_UNSUPPORTED_CHARGE', `order.${key}`);
  }
}

function reconcile(order, key, expected, code = 'FINANCIAL_RECONCILIATION_MISMATCH') {
  const reported = amount(order, key, 'order', false);
  if (reported !== null && reported !== expected) fail(code, `order.${key}`);
  return reported;
}

/**
 * Resolve finalized, paid EUR Shopify order finances using exact integer cents.
 * Accepts an order object or JSON string; returns only the factory financial contract.
 * Throws an Error with a stable FINANCIAL_* code and a non-sensitive field path.
 * Edited/current totals must agree with original totals; refunds/returns are unsupported.
 */
export function resolveFactoryFinancialData(rawPayload) {
  let order = rawPayload;
  if (typeof order === 'string') {
    try { order = JSON.parse(order); }
    catch { fail('FINANCIAL_INVALID_PAYLOAD', 'order'); }
  }
  if (!record(order)) fail('FINANCIAL_INVALID_PAYLOAD', 'order');
  identity(order.id, 'order.id');
  if (order.financial_status !== 'paid') fail('FINANCIAL_ORDER_NOT_PAID', 'order.financial_status');
  if (typeof order.taxes_included !== 'boolean') fail('FINANCIAL_INVALID_TAX_STATUS', 'order.taxes_included');
  let currencyEstablished = false;
  for (const key of ['currency', 'presentment_currency']) {
    if (has(order, key)) { currency(order[key], `order.${key}`); currencyEstablished = true; }
  }
  if (has(order, 'total_price_set')) {
    moneySet(order.total_price_set, 'order.total_price_set');
    currencyEstablished = true;
  }
  if (!currencyEstablished) fail('FINANCIAL_MISSING_CURRENCY', 'order.currency');
  rejectUnsupported(order);
  const paymentMethod = provider(order);
  const orderTotal = amount(order, 'total_price', 'order');
  reconcile(order, 'current_total_price', orderTotal, 'FINANCIAL_UNSUPPORTED_ORDER_EDIT');
  const source = array(order, 'line_items', 'order', true);
  if (!source.length) fail('FINANCIAL_MISSING_LINE_ITEMS', 'order.line_items');
  const applications = has(order, 'discount_applications') ? array(order, 'discount_applications', 'order') : null;
  for (const [index, application] of (applications ?? []).entries()) {
    if (!record(application) || !['line_item', 'shipping_line'].includes(application.target_type) ||
        !['fixed_amount', 'percentage'].includes(application.value_type)) {
      fail('FINANCIAL_INVALID_DISCOUNT', `order.discount_applications[${index}]`);
    }
    // Validate metadata without using it to calculate or redistribute discounts.
    const value = application.value;
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        !/^\d+(?:\.\d+)?$/.test(String(value)) ||
        (application.value_type === 'percentage' && Number(value) > 100)) {
      fail('FINANCIAL_INVALID_DISCOUNT', `order.discount_applications[${index}].value`);
    }
    if (application.value_type === 'fixed_amount') cents(value, `order.discount_applications[${index}].value`);
  }
  const usedApplications = new Set();
  const ids = new Set();
  let positionTotal = 0n;
  let baseTotal = 0n;
  let lineDiscountTotal = 0n;
  let taxTotal = 0n;
  let hasDirectDiscount = false;
  const positions = [];
  for (const [sourcePosition, line] of source.entries()) {
    const path = `order.line_items[${sourcePosition}]`;
    if (!record(line)) fail('FINANCIAL_INVALID_STRUCTURE', path);
    const shopifyLineItemId = identity(line.id, `${path}.id`);
    if (ids.has(shopifyLineItemId)) fail('FINANCIAL_DUPLICATE_LINE_ITEM_ID', `${path}.id`);
    ids.add(shopifyLineItemId);
    if (typeof line.sku !== 'string' || !line.sku.trim()) fail('FINANCIAL_INVALID_SKU', `${path}.sku`);
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) fail('FINANCIAL_INVALID_QUANTITY', `${path}.quantity`);
    if (has(line, 'current_quantity') && line.current_quantity !== line.quantity) {
      fail('FINANCIAL_UNSUPPORTED_ORDER_EDIT', `${path}.current_quantity`);
    }
    if (array(line, 'duties', path).length) fail('FINANCIAL_UNSUPPORTED_CHARGE', `${path}.duties`);
    if (line.tip_payment_gateway != null || line.tip_payment_method != null) {
      fail('FINANCIAL_UNSUPPORTED_CHARGE', path);
    }
    const base = amount(line, 'price', path) * BigInt(line.quantity);
    const allocated = allocations(line, path, 'line_item', applications, usedApplications);
    const direct = amount(line, 'total_discount', path, false);
    let discount = allocated.total;
    if (allocated.count) {
      // Shopify often leaves the legacy direct-discount field at zero.
      if (direct !== null && direct !== 0n && direct !== discount) fail('FINANCIAL_INVALID_DISCOUNT', path);
    } else {
      if (direct === null && !has(line, 'discount_allocations')) fail('FINANCIAL_MISSING_DISCOUNT_DATA', path);
      discount = direct ?? 0n;
      if (discount > 0n) {
        // Without allocations, an order-level application cannot be assigned safely.
        if (applications?.some(application => application.target_type === 'line_item') ||
            array(order, 'discount_codes', 'order').length) fail('FINANCIAL_AMBIGUOUS_DIRECT_DISCOUNT', path);
        hasDirectDiscount = true;
      }
    }
    if (discount > base) fail('FINANCIAL_DISCOUNT_EXCEEDS_PRICE', path);
    const lineTax = tax(line, path, order.taxes_included);
    const discounted = base - discount;
    if ((order.taxes_included && lineTax > discounted) || (discounted === 0n && lineTax !== 0n)) {
      fail('FINANCIAL_INVALID_TAX', path);
    }
    const total = discounted + (order.taxes_included ? 0n : lineTax);
    if (total === 0n && (base === 0n || discount !== base)) fail('FINANCIAL_INVALID_ZERO_POSITION', path);
    baseTotal += base;
    lineDiscountTotal += discount;
    taxTotal += lineTax;
    positionTotal += total;
    positions.push({ shopifyLineItemId, sourcePosition, sku: line.sku, quantity: line.quantity, totalPrice: formatted(total) });
  }

  let shippingBase = 0n;
  let shippingNet = 0n;
  let shippingTax = 0n;
  let activeShipping = 0;
  for (const [index, line] of array(order, 'shipping_lines', 'order').entries()) {
    const path = `order.shipping_lines[${index}]`;
    if (!record(line)) fail('FINANCIAL_INVALID_STRUCTURE', path);
    if (has(line, 'is_removed') && typeof line.is_removed !== 'boolean') fail('FINANCIAL_INVALID_STRUCTURE', `${path}.is_removed`);
    if (line.is_removed === true) continue;
    activeShipping++;
    const base = amount(line, 'price', path);
    const allocated = allocations(line, path, 'shipping_line', applications, usedApplications);
    const reported = amount(line, 'discounted_price', path, false);
    if (reported === null && !has(line, 'discount_allocations')) {
      fail('FINANCIAL_MISSING_DISCOUNT_DATA', path);
    }
    if (allocated.total > base) fail('FINANCIAL_DISCOUNT_EXCEEDS_PRICE', path);
    const discounted = reported ?? (base - allocated.total);
    if (discounted > base || (allocated.count && discounted !== base - allocated.total)) {
      fail('FINANCIAL_INVALID_DISCOUNT', path);
    }
    const current = amount(line, 'current_discounted_price', path, false);
    if (current !== null && current !== discounted) fail('FINANCIAL_UNSUPPORTED_ORDER_EDIT', path);
    const lineTax = tax(line, path, order.taxes_included);
    if ((order.taxes_included && lineTax > discounted) || (discounted === 0n && lineTax !== 0n)) {
      fail('FINANCIAL_INVALID_TAX', path);
    }
    shippingBase += base;
    shippingNet += discounted;
    shippingTax += lineTax;
  }
  // REST total_shipping_price_set is the original shipping price; current_shipping_price_set
  // is after discounts. Both follow taxes_included, so exclusive shipping tax is added only below.
  const originalShipping = reconcile(order, 'total_shipping_price', shippingBase, 'FINANCIAL_SHIPPING_MISMATCH');
  const currentShipping = reconcile(order, 'current_shipping_price', shippingNet, 'FINANCIAL_SHIPPING_MISMATCH');
  if (!activeShipping && originalShipping === null && currentShipping === null) {
    fail('FINANCIAL_MISSING_SHIPPING', 'order.shipping_lines');
  }
  const shippingCosts = shippingNet + (order.taxes_included ? 0n : shippingTax);
  const discounts = lineDiscountTotal + shippingBase - shippingNet;
  const reportedDiscounts = reconcile(order, 'total_discounts', discounts, 'FINANCIAL_DISCOUNT_MISMATCH');
  reconcile(order, 'current_total_discounts', discounts, 'FINANCIAL_DISCOUNT_MISMATCH');
  if (hasDirectDiscount && reportedDiscounts === null) fail('FINANCIAL_AMBIGUOUS_DIRECT_DISCOUNT', 'order.total_discounts');
  if (applications?.some((_, index) => !usedApplications.has(index))) {
    fail('FINANCIAL_UNALLOCATED_DISCOUNT', 'order.discount_applications');
  }
  // Discount codes are metadata, never another deduction. Require a reconciled summary.
  const discountCodes = array(order, 'discount_codes', 'order');
  let codedDiscounts = 0n;
  for (const [index, entry] of discountCodes.entries()) {
    const path = `order.discount_codes[${index}]`;
    if (!record(entry) || !['fixed_amount', 'percentage', 'shipping'].includes(entry.type)) {
      fail('FINANCIAL_INVALID_DISCOUNT', path);
    }
    codedDiscounts += amount(entry, 'amount', path);
  }
  if (discountCodes.length && reportedDiscounts === null) {
    fail('FINANCIAL_UNALLOCATED_DISCOUNT', 'order.discount_codes');
  }
  if (codedDiscounts > discounts) fail('FINANCIAL_DISCOUNT_MISMATCH', 'order.discount_codes');
  reconcile(order, 'total_line_items_price', baseTotal);
  reconcile(order, 'subtotal_price', baseTotal - lineDiscountTotal);
  reconcile(order, 'current_subtotal_price', baseTotal - lineDiscountTotal, 'FINANCIAL_UNSUPPORTED_ORDER_EDIT');
  reconcile(order, 'total_tax', taxTotal + shippingTax, 'FINANCIAL_TAX_MISMATCH');
  reconcile(order, 'current_total_tax', taxTotal + shippingTax, 'FINANCIAL_TAX_MISMATCH');
  if (has(order, 'tax_lines') && tax(order, 'order', order.taxes_included) !== taxTotal + shippingTax) {
    fail('FINANCIAL_TAX_MISMATCH', 'order.tax_lines');
  }
  if (positionTotal + shippingCosts !== orderTotal) fail('FINANCIAL_RECONCILIATION_MISMATCH', 'order.total_price');
  return { currency: 'EUR', paymentMethod, shippingCosts: formatted(shippingCosts), orderTotal: formatted(orderTotal), positions };
}

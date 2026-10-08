import assert from 'node:assert/strict';
import { resolveFactoryFinancialData as resolve } from '../src/services/FactoryFinancialDataService.js';

// SANITIZED SYNTHETIC FIXTURES: only the four order IDs and financial figures
// were supplied as verified facts. Line IDs, SKUs and other fields below are invented.
// These are not original complete Shopify webhook payloads.
const money = amount => ({ shop_money: { amount, currency_code: 'EUR' }, presentment_money: { amount, currency_code: 'EUR' } });
const allocation = (amount, index) => ({ amount_set: money(amount), ...(index === undefined ? {} : { discount_application_index: index }) });
const taxLine = price => ({ price_set: money(price), rate: 0.19 });
const line = (price = '100.00', index = 0) => ({
  id: String(19647761088850n + BigInt(index)), sku: `synthetic-sku-${index + 1}`, quantity: 1,
  price_set: money(price), total_discount: '0.00', discount_allocations: [], tax_lines: [],
});
const shipping = (price = '0.00') => ({ price_set: money(price), discount_allocations: [], tax_lines: [] });
function fixture(prices = ['100.00'], total = '100.00', id = '8482267791698') {
  return {
    id, currency: 'EUR', presentment_currency: 'EUR', financial_status: 'paid', taxes_included: true,
    source_name: 'shopify_draft_order', payment_gateway_names: ['shopify_payments'],
    total_price_set: money(total), total_discounts_set: money('0.00'),
    total_shipping_price_set: money('0.00'), shipping_lines: [shipping()],
    line_items: prices.map(line), refunds: [], returns: [], discount_applications: [],
  };
}
function expected(order, totals, shippingCosts, orderTotal, paymentMethod = 'Shopify Payments') {
  return {
    currency: 'EUR', paymentMethod, shippingCosts, orderTotal,
    positions: order.line_items.map((item, sourcePosition) => ({
      shopifyLineItemId: String(item.id), sourcePosition, sku: item.sku, quantity: item.quantity,
      totalPrice: totals[sourcePosition],
    })),
  };
}
let passed = 0;
let failed = 0;
function test(name, run) {
  try { run(); passed++; }
  catch (error) { failed++; console.error(`FAIL: ${name}`); console.error(error); }
}
function rejects(name, mutate, code, create = fixture) {
  test(name, () => {
    const order = create();
    mutate(order);
    assert.throws(() => resolve(order), error => {
      assert.equal(error.code, code);
      assert.match(error.message, new RegExp(`^${code}: `));
      return true;
    });
  });
}

const references = [
  ['8482023506258', ['58.88', '239.85', '32.46'], '331.19'],
  ['8482039497042', ['32.46', '52.00', '342.90', '263.25'], '690.61'],
  ['8482051785042', ['52.68', '234.00', '48.75'], '335.43'],
  ['8482267791698', ['192.21', '175.26', '32.46'], '399.93'],
];
for (const [id, prices, total] of references) {
  test(`synthetic reference ${id}`, () => {
    const order = fixture(prices, total, id);
    assert.deepEqual(resolve(order), expected(order, prices, '0.00', total));
    assert.deepEqual(resolve(JSON.stringify(order)), resolve(order));
  });
}
test('accessory quantity two', () => {
  const order = fixture(['32.46'], '64.92');
  order.line_items[0].quantity = 2;
  assert.deepEqual(resolve(order), expected(order, ['64.92'], '0.00', '64.92'));
});
test('identical SKUs retain independent source positions', () => {
  const order = fixture(['32.46', '100.00'], '132.46');
  order.line_items.forEach(item => { item.sku = 'same-sku'; });
  order.line_items[0].id = '9007199254740993123';
  assert.deepEqual(resolve(order), expected(order, ['32.46', '100.00'], '0.00', '132.46'));
});
test('wallpaper totals ignore panel count and checkout/configurator properties', () => {
  const order = fixture();
  order.line_items[0].sku = '20-140.1-3';
  order.line_items[0].properties = [{ name: 'panel_count', value: '5' }, { name: '_checkout_proof', value: 'ignored' }];
  order.line_items[0].panel_count = 5;
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
  order.line_items[0].panel_count = 15;
  assert.equal(resolve(order).positions[0].totalPrice, '100.00');
});
test('tax inclusive does not add tax a second time', () => {
  const order = fixture();
  order.line_items[0].tax_lines = [taxLine('15.97')];
  order.total_tax_set = money('15.97');
  order.tax_lines = [taxLine('15.97')];
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
});
test('tax exclusive uses multiple actual monetary tax lines, ignoring rates', () => {
  const order = fixture(['100.00'], '108.37');
  order.taxes_included = false;
  order.line_items[0].tax_lines = [taxLine('5.00'), taxLine('3.37')];
  order.total_tax = '8.37';
  assert.deepEqual(resolve(order), expected(order, ['108.37'], '0.00', '108.37'));
});
function discountedFixture(values = ['10.00'], total = '90.00', type = 'fixed_amount') {
  const order = fixture(['100.00'], total);
  order.discount_applications = values.map(() => ({ target_type: 'line_item', value_type: type, value: type === 'percentage' ? '10' : '10.00' }));
  order.line_items[0].discount_allocations = values.map(allocation);
  order.total_discounts_set = money(values.length === 2 ? '15.00' : values[0]);
  return order;
}
for (const type of ['fixed_amount', 'percentage']) {
  test(`${type} allocations, not recalculated discount rates`, () => {
    const order = discountedFixture(['12.34'], '87.66', type);
    assert.deepEqual(resolve(order), expected(order, ['87.66'], '0.00', '87.66'));
  });
}
test('multiple simultaneous allocations and prevention of double subtraction', () => {
  const order = discountedFixture(['10.00', '5.00'], '85.00');
  order.line_items[0].total_discount_set = money('15.00');
  order.line_items[0].total_discount = '15.00';
  order.discount_codes = [{ code: 'synthetic', amount: '15.00', type: 'fixed_amount' }];
  assert.deepEqual(resolve(order), expected(order, ['85.00'], '0.00', '85.00'));
});
test('discounts belong to line IDs even with identical SKUs', () => {
  const order = fixture(['100.00', '100.00'], '175.00');
  order.line_items.forEach(item => { item.sku = 'same-sku'; });
  order.line_items[0].discount_allocations = [allocation('10.00')];
  order.line_items[1].discount_allocations = [allocation('15.00')];
  order.total_discounts_set = money('25.00');
  assert.deepEqual(resolve(order), expected(order, ['90.00', '85.00'], '0.00', '175.00'));
});
test('direct line discount with an independently reconciled order discount total', () => {
  const order = fixture(['100.00'], '90.00');
  order.line_items[0].total_discount = '10.00';
  order.total_discounts_set = money('10.00');
  assert.deepEqual(resolve(order), expected(order, ['90.00'], '0.00', '90.00'));
});
test('fully discounted line legitimately totals zero', () => {
  const order = discountedFixture(['100.00'], '0.00');
  assert.deepEqual(resolve(order), expected(order, ['0.00'], '0.00', '0.00'));
});
test('exclusive tax follows discounted merchandise total', () => {
  const order = discountedFixture(['10.00'], '107.10');
  order.taxes_included = false;
  order.line_items[0].tax_lines = [taxLine('17.10')];
  assert.deepEqual(resolve(order), expected(order, ['107.10'], '0.00', '107.10'));
});
function shippingFixture({ inclusive = true, discounted = false, reported = true } = {}) {
  const order = fixture(['100.00'], inclusive ? (discounted ? '107.00' : '110.00') : (discounted ? '127.33' : '130.90'));
  order.taxes_included = inclusive;
  order.shipping_lines = [shipping('10.00')];
  order.total_shipping_price_set = money('10.00');
  if (!inclusive) order.line_items[0].tax_lines = [taxLine('19.00')];
  if (discounted) {
    order.discount_applications = [{ target_type: 'shipping_line', value_type: 'fixed_amount', value: '3.00' }];
    order.shipping_lines[0].discount_allocations = [allocation('3.00', 0)];
    order.total_discounts_set = money('3.00');
    if (reported) order.shipping_lines[0].discounted_price_set = money('7.00');
  }
  order.current_shipping_price_set = money(discounted ? '7.00' : '10.00');
  order.shipping_lines[0].tax_lines = [taxLine(inclusive ? '1.00' : discounted ? '1.33' : '1.90')];
  return order;
}
for (const inclusive of [true, false]) {
  for (const discounted of [true, false]) {
    for (const reported of [true, false]) {
      test(`shipping inclusive=${inclusive}, discount=${discounted}, reported=${reported}`, () => {
        const order = shippingFixture({ inclusive, discounted, reported });
        const charge = inclusive ? (discounted ? '7.00' : '10.00') : (discounted ? '8.33' : '11.90');
        const total = inclusive ? (discounted ? '107.00' : '110.00') : (discounted ? '127.33' : '130.90');
        assert.deepEqual(resolve(order), expected(order, [inclusive ? '100.00' : '119.00'], charge, total));
      });
    }
  }
}
test('free shipping from a fully allocated shipping discount', () => {
  const order = fixture();
  order.shipping_lines = [shipping('10.00')];
  order.shipping_lines[0].discounted_price_set = money('0.00');
  order.shipping_lines[0].discount_allocations = [allocation('10.00')];
  order.total_shipping_price_set = money('10.00');
  order.total_discounts_set = money('10.00');
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
});
test('authoritative discounted shipping does not require duplicate allocations', () => {
  const order = shippingFixture({ discounted: true });
  delete order.discount_applications;
  order.shipping_lines[0].discount_allocations = [];
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '7.00', '107.00'));
});
test('multiple shipping lines and removed shipping exclusion', () => {
  const order = fixture(['100.00'], '107.00');
  order.shipping_lines = [shipping('2.00'), { is_removed: true, price_set: null }, shipping('5.00')];
  order.total_shipping_price_set = money('7.00');
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '7.00', '107.00'));
});
for (const mode of ['missing', 'empty', 'removed']) {
  test(`${mode} shipping lines require authoritative zero`, () => {
    const order = fixture();
    if (mode === 'missing') delete order.shipping_lines;
    else order.shipping_lines = mode === 'empty' ? [] : [{ is_removed: true }];
    assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
  });
}
for (const [names, paymentMethod] of [
  [['SHOPIFY_PAYMENTS', 'shopify_payments'], 'Shopify Payments'],
  [['PayPal_Express', 'paypal'], 'PayPal'], [['stripe_card'], 'Stripe'], [['MOLLIE_payments'], 'Mollie'],
]) {
  test(`payment ${paymentMethod}`, () => {
    const order = fixture();
    order.payment_gateway_names = names;
    assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00', paymentMethod));
  });
}
test('legacy scalar financial fields with established EUR', () => {
  const order = fixture(['32.46'], '64.92');
  order.line_items[0].quantity = 2;
  delete order.line_items[0].price_set;
  order.line_items[0].price = 32.46;
  delete order.total_price_set;
  order.total_price = '64.92';
  delete order.shipping_lines[0].price_set;
  order.shipping_lines[0].price = 0;
  assert.deepEqual(resolve(order), expected(order, ['64.92'], '0.00', '64.92'));
});
test('money sets establish EUR without scalar order currency fields', () => {
  const order = fixture();
  delete order.currency;
  delete order.presentment_currency;
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
});
test('large string money is calculated exactly with BigInt', () => {
  const order = fixture(['9007199254740993.99'], '18014398509481987.98');
  order.line_items[0].quantity = 2;
  assert.deepEqual(resolve(order), expected(order, ['18014398509481987.98'], '0.00', '18014398509481987.98'));
});
test('object and JSON input are deterministic and frozen inputs remain untouched', () => {
  const order = discountedFixture();
  const snapshot = structuredClone(order);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(order);
  const result = resolve(order);
  assert.deepEqual(result, expected(order, ['90.00'], '0.00', '90.00'));
  assert.deepEqual(resolve(order), resolve(JSON.stringify(order)));
  assert.deepEqual(order, snapshot);
  result.positions[0].sku = 'changed output';
  assert.deepEqual(order, snapshot);
});

for (const value of [null, [], true, 123, '{}', '{bad json with PRIVATE_TOKEN', 'null']) {
  test('invalid payload fails closed', () => assert.throws(() => resolve(value), error => {
    assert.match(error.code, /^FINANCIAL_(INVALID_PAYLOAD|INVALID_ID)$/);
    assert.ok(!error.message.includes('PRIVATE_TOKEN'));
    return true;
  }));
}
rejects('missing provider', o => { delete o.payment_gateway_names; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('empty provider list', o => { o.payment_gateway_names = []; }, 'FINANCIAL_MISSING_PAYMENT_PROVIDER');
rejects('empty provider', o => { o.payment_gateway_names = ['']; }, 'FINANCIAL_MISSING_PAYMENT_PROVIDER');
rejects('unknown provider', o => { o.payment_gateway_names = ['manual']; }, 'FINANCIAL_UNSUPPORTED_PAYMENT_PROVIDER');
rejects('supported plus unknown provider', o => { o.payment_gateway_names.push('manual'); }, 'FINANCIAL_UNSUPPORTED_PAYMENT_PROVIDER');
rejects('multiple providers', o => { o.payment_gateway_names.push('paypal'); }, 'FINANCIAL_MULTIPLE_PAYMENT_PROVIDERS');
rejects('ambiguous single identifier', o => { o.payment_gateway_names = ['mollie_paypal']; }, 'FINANCIAL_UNSUPPORTED_PAYMENT_PROVIDER');
rejects('unpaid', o => { o.financial_status = 'pending'; }, 'FINANCIAL_ORDER_NOT_PAID');
for (const value of [undefined, null, 'true', 0]) {
  rejects('invalid tax status', o => { o.taxes_included = value; }, 'FINANCIAL_INVALID_TAX_STATUS');
}
for (const key of ['currency', 'presentment_currency']) {
  for (const value of ['USD', 'eur', null]) {
    rejects(`unsupported ${key}`, o => { o[key] = value; }, 'FINANCIAL_UNSUPPORTED_CURRENCY');
  }
}
rejects('currency absent for scalar-only total', o => {
  delete o.currency; delete o.presentment_currency; delete o.total_price_set; o.total_price = '100.00';
}, 'FINANCIAL_MISSING_CURRENCY');
for (const key of ['shop_money', 'presentment_money']) {
  rejects(`mismatched ${key}`, o => { o.line_items[0].price_set[key].currency_code = 'USD'; }, 'FINANCIAL_UNSUPPORTED_CURRENCY');
}
for (const value of ['1.001', '-1', 'NaN', 'Infinity', '1e2', ' 100.00', '100,00', '', null, false, {}, [], NaN, Infinity, -1, -0]) {
  rejects(`invalid monetary value ${String(value)}`, o => { o.line_items[0].price_set = money(value); }, 'FINANCIAL_INVALID_MONEY');
}
rejects('unsafe numeric money', o => { o.line_items[0].price_set = money(Number.MAX_SAFE_INTEGER); }, 'FINANCIAL_UNSAFE_MONEY_NUMBER');
for (const value of [null, {}, { shop_money: { amount: '100.00', currency_code: 'EUR' } }, { presentment_money: null }]) {
  rejects('malformed money set never falls back', o => { o.line_items[0].price_set = value; o.line_items[0].price = '100.00'; }, 'FINANCIAL_INVALID_MONEY_SET');
}
rejects('conflicting scalar and money set', o => { o.line_items[0].price = '99.00'; }, 'FINANCIAL_INCONSISTENT_MONEY');
rejects('conflicting EUR shop and presentment amounts', o => { o.line_items[0].price_set.shop_money.amount = '99.00'; }, 'FINANCIAL_INCONSISTENT_MONEY');
rejects('missing unit price', o => { delete o.line_items[0].price_set; }, 'FINANCIAL_MISSING_MONEY');
rejects('missing order total', o => { delete o.total_price_set; }, 'FINANCIAL_MISSING_MONEY');
rejects('missing line items', o => { delete o.line_items; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('no line items', o => { o.line_items = []; }, 'FINANCIAL_MISSING_LINE_ITEMS');
rejects('missing SKU', o => { delete o.line_items[0].sku; }, 'FINANCIAL_INVALID_SKU');
rejects('whitespace SKU', o => { o.line_items[0].sku = ' '; }, 'FINANCIAL_INVALID_SKU');
for (const value of [undefined, null, '', ' ', 0, -1, '0', '001', '1.2', 1.2, Number.MAX_SAFE_INTEGER + 1]) {
  rejects('invalid order ID', o => { o.id = value; }, 'FINANCIAL_INVALID_ID');
  rejects('invalid line ID', o => { o.line_items[0].id = value; }, 'FINANCIAL_INVALID_ID');
}
test('unsafe JSON numeric IDs are rejected after parsing', () => {
  const json = JSON.stringify(fixture()).replace('"19647761088850"', '9007199254740993');
  assert.throws(() => resolve(json), { code: 'FINANCIAL_INVALID_ID' });
});
rejects('duplicate ID, string and number', o => {
  o.line_items.push({ ...line(), id: Number(o.line_items[0].id) });
}, 'FINANCIAL_DUPLICATE_LINE_ITEM_ID');
for (const value of [undefined, null, 0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  rejects('invalid quantity', o => { o.line_items[0].quantity = value; }, 'FINANCIAL_INVALID_QUANTITY');
}
rejects('one cent order mismatch', o => { o.total_price_set = money('100.01'); }, 'FINANCIAL_RECONCILIATION_MISMATCH');
rejects('zero base is not a fully discounted line', o => { o.line_items[0].price_set = money('0.00'); o.total_price_set = money('0.00'); }, 'FINANCIAL_INVALID_ZERO_POSITION');
rejects('discount exceeds subtotal', o => { o.line_items[0].discount_allocations = [allocation('100.01')]; }, 'FINANCIAL_DISCOUNT_EXCEEDS_PRICE');
rejects('contradictory direct discount', o => { o.line_items[0].discount_allocations = [allocation('10.00')]; o.line_items[0].total_discount = '11.00'; }, 'FINANCIAL_INVALID_DISCOUNT');
rejects('malformed allocations', o => { o.line_items[0].discount_allocations = null; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('missing allocation amount', o => { o.line_items[0].discount_allocations = [{}]; }, 'FINANCIAL_MISSING_MONEY');
rejects('foreign allocation currency', o => { o.line_items[0].discount_allocations = [allocation('10.00')]; o.line_items[0].discount_allocations[0].amount_set.presentment_money.currency_code = 'GBP'; }, 'FINANCIAL_UNSUPPORTED_CURRENCY');
rejects('no discount evidence', o => { delete o.line_items[0].discount_allocations; delete o.line_items[0].total_discount; }, 'FINANCIAL_MISSING_DISCOUNT_DATA');
rejects('ambiguous direct discount without order total', o => { o.line_items[0].total_discount = '10.00'; delete o.total_discounts_set; }, 'FINANCIAL_AMBIGUOUS_DIRECT_DISCOUNT');
rejects('direct discount conflicts with order applications', o => {
  o.line_items[0].discount_allocations = []; o.line_items[0].total_discount = '10.00';
}, 'FINANCIAL_AMBIGUOUS_DIRECT_DISCOUNT', discountedFixture);
rejects('duplicate allocation for same application', o => {
  o.line_items[0].discount_allocations.push(allocation('10.00', 0));
}, 'FINANCIAL_INVALID_DISCOUNT', discountedFixture);
rejects('out of range allocation index', o => { o.line_items[0].discount_allocations[0].discount_application_index = 2; }, 'FINANCIAL_INVALID_DISCOUNT', discountedFixture);
rejects('unallocated order discount', o => {
  o.discount_applications = [{ target_type: 'line_item', value_type: 'percentage', value: '10' }];
}, 'FINANCIAL_UNALLOCATED_DISCOUNT');
rejects('unallocated discount code', o => { o.discount_codes = [{ code: 'synthetic', amount: '10.00', type: 'fixed_amount' }]; delete o.total_discounts_set; }, 'FINANCIAL_UNALLOCATED_DISCOUNT');
rejects('discount code contradicts allocated total', o => { o.discount_codes = [{ code: 'synthetic', amount: '10.00', type: 'fixed_amount' }]; }, 'FINANCIAL_DISCOUNT_MISMATCH');
rejects('discount code amount invalid', o => { o.discount_codes = [{ code: 'synthetic', amount: '-1.00', type: 'percentage' }]; }, 'FINANCIAL_INVALID_MONEY');
rejects('discount application value invalid', o => { o.discount_applications[0].value = '-10'; }, 'FINANCIAL_INVALID_DISCOUNT', discountedFixture);
rejects('discount application percentage exceeds 100', o => { o.discount_applications[0].value_type = 'percentage'; o.discount_applications[0].value = '101'; }, 'FINANCIAL_INVALID_DISCOUNT', discountedFixture);
rejects('order discount summary mismatch', o => { o.total_discounts_set = money('1.00'); }, 'FINANCIAL_DISCOUNT_MISMATCH');
rejects('exclusive missing line tax data', o => { o.taxes_included = false; delete o.line_items[0].tax_lines; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('invalid tax money', o => { o.line_items[0].tax_lines = [taxLine('1.001')]; }, 'FINANCIAL_INVALID_MONEY');
rejects('inclusive tax exceeds amount', o => { o.line_items[0].tax_lines = [taxLine('101.00')]; }, 'FINANCIAL_INVALID_TAX');
rejects('order tax summary mismatch', o => { o.total_tax_set = money('1.00'); }, 'FINANCIAL_TAX_MISMATCH');
rejects('shipping amount absent', o => { o.shipping_lines = [{}]; }, 'FINANCIAL_MISSING_MONEY');
rejects('shipping discount data absent', o => { delete o.shipping_lines[0].discount_allocations; }, 'FINANCIAL_MISSING_DISCOUNT_DATA');
rejects('missing shipping without authoritative zero', o => { delete o.shipping_lines; delete o.total_shipping_price_set; }, 'FINANCIAL_MISSING_SHIPPING');
rejects('empty shipping with nonzero summary', o => { o.shipping_lines = []; o.total_shipping_price_set = money('1.00'); }, 'FINANCIAL_SHIPPING_MISMATCH');
rejects('shipping summary includes unreported tax', o => { o.total_shipping_price_set = money('11.90'); }, 'FINANCIAL_SHIPPING_MISMATCH', () => shippingFixture({ inclusive: false }));
rejects('shipping discounted amount conflicts with allocation', o => { o.shipping_lines[0].discounted_price_set = money('6.00'); }, 'FINANCIAL_INVALID_DISCOUNT', () => shippingFixture({ discounted: true }));
rejects('shipping malformed discounted set cannot fall back', o => { o.shipping_lines[0].discounted_price_set = null; o.shipping_lines[0].discounted_price = '0.00'; }, 'FINANCIAL_INVALID_MONEY_SET');
rejects('exclusive shipping lacks tax data', o => { o.taxes_included = false; delete o.shipping_lines[0].tax_lines; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('invalid removal flag', o => { o.shipping_lines[0].is_removed = 'true'; }, 'FINANCIAL_INVALID_STRUCTURE');
rejects('current order total differs', o => { o.current_total_price_set = money('90.00'); }, 'FINANCIAL_UNSUPPORTED_ORDER_EDIT');
rejects('current quantity differs', o => { o.line_items[0].current_quantity = 0; }, 'FINANCIAL_UNSUPPORTED_ORDER_EDIT');
rejects('current shipping differs', o => { o.shipping_lines[0].current_discounted_price_set = money('1.00'); }, 'FINANCIAL_UNSUPPORTED_ORDER_EDIT');
for (const key of ['total_tip_received', 'total_duties', 'original_total_duties', 'current_total_duties', 'total_additional_fees', 'original_total_additional_fees', 'current_total_additional_fees', 'total_cash_rounding_payment_adjustment', 'total_cash_rounding_refund_adjustment']) {
  rejects(`unsupported ${key}`, o => { o[`${key}_set`] = money('0.01'); }, 'FINANCIAL_UNSUPPORTED_CHARGE');
}
rejects('negative cash rounding adjustment', o => { o.total_cash_rounding_payment_adjustment_set = money('-0.01'); }, 'FINANCIAL_INVALID_MONEY');
rejects('line duties', o => { o.line_items[0].duties = [{ price_set: money('1.00') }]; }, 'FINANCIAL_UNSUPPORTED_CHARGE');
rejects('tip represented as a priced line item', o => { o.line_items[0].tip_payment_gateway = 'shopify_payments'; }, 'FINANCIAL_UNSUPPORTED_CHARGE');
rejects('null tip is not authoritative zero', o => { o.total_tip_received = null; }, 'FINANCIAL_INVALID_MONEY');
rejects('fee records', o => { o.additional_fees = [{}]; }, 'FINANCIAL_UNSUPPORTED_CHARGE');
for (const key of ['refunds', 'returns']) {
  rejects(`nonempty ${key}`, o => { o[key] = [{ id: '1' }]; }, 'FINANCIAL_UNSUPPORTED_REFUND_RETURN');
  rejects(`malformed ${key}`, o => { o[key] = {}; }, 'FINANCIAL_INVALID_STRUCTURE');
}
test('nullable duty/fee summaries and explicit zero unsupported charges', () => {
  const order = fixture();
  order.original_total_duties_set = null;
  order.current_total_additional_fees_set = null;
  order.total_tip_received = '0.00';
  order.total_cash_rounding_payment_adjustment_set = money('0.00');
  assert.deepEqual(resolve(order), expected(order, ['100.00'], '0.00', '100.00'));
});
test('errors contain paths/codes, never private field values', () => {
  const order = fixture();
  order.email = 'private@example.test';
  order.token = 'PRIVATE_TOKEN';
  order.line_items[0].price_set = money('PRIVATE_CHECKOUT_PROOF');
  assert.throws(() => resolve(order), error => {
    assert.equal(error.code, 'FINANCIAL_INVALID_MONEY');
    assert.equal(error.message, 'FINANCIAL_INVALID_MONEY: order.line_items[0].price_set.presentment_money.amount');
    assert.ok(!JSON.stringify(error).includes('PRIVATE'));
    return true;
  });
});

console.log(`Factory financial data smoke tests: ${passed} passed; ${failed} failed (sanitized synthetic fixtures).`);
if (failed) process.exitCode = 1;

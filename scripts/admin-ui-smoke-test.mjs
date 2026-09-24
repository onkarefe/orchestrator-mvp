import assert from 'node:assert/strict';
import admin, { formatAdminTimestamp, checkoutSecurity, adminJson } from '../src/utils/adminDisplay.js';
import DashboardController, { summarizeRecentOrders } from '../src/controllers/admin/DashboardController.js';
import { fixtureRows, fixtureToken, startFixtureAdmin } from './fixtures/admin-ui.mjs';

assert.equal(formatAdminTimestamp('2026-09-24T11:30:10Z'), '24.09.2026, 13:30:10 GMT+2');
assert.equal(formatAdminTimestamp('2026-01-24T11:30:10Z'), '24.01.2026, 12:30:10 GMT+1');
assert.equal(formatAdminTimestamp(new Date('2026-09-24T11:30:10Z')), formatAdminTimestamp('2026-09-24T11:30:10Z'));
for (const invalid of [null, undefined, '', 'nonsense', new Date(NaN), {}, 0]) assert.equal(formatAdminTimestamp(invalid), '\u2014');
assert.equal(formatAdminTimestamp('2026-03-29T00:59:59Z'), '29.03.2026, 01:59:59 GMT+1');
assert.equal(formatAdminTimestamp('2026-03-29T01:00:00Z'), '29.03.2026, 03:00:00 GMT+2');
assert.equal(admin.statusClass('SECURITY_HOLD'), 'status-critical');
assert.equal(admin.statusClass('completed, failed'), 'status-critical');
assert.equal(admin.statusClass('manual_review'), 'status-warning');
assert.equal(admin.statusClass('pending'), 'status-info');
assert.equal(admin.statusClass('PASS'), 'status-success');
assert.equal(admin.statusClass(null), 'status-neutral');
assert.equal(admin.statusLabel('SECURITY_HOLD'), 'SECURITY HOLD');
assert.equal(admin.display('ftp://user:password@factory.test/path'), 'ftp://[REDACTED]@factory.test/path');
assert.match(adminJson({ at: new Date('2026-09-24T11:30:10Z') }), /2026-09-24T11:30:10.000Z/);
assert.equal(admin.booleanLabel('0'), 'Invalid');
assert.equal(admin.booleanLabel(null), 'Not checked');
assert.equal(checkoutSecurity({ status: 'SECURITY_HOLD', checkout_security_json: '{bad' }).held, true);
assert.equal(checkoutSecurity({ checkout_security_json: '{"result":"NOT_APPLICABLE"}' }).result, 'N/A');
assert.equal(checkoutSecurity({}).result, 'Not checked');
const payload = { note_attributes: [{ name: 'wandini_checkout_proof', value: 'proof-value' }],
  signature: 'signature-value', secret: 'secret-value', visible: 'safe' };
const serialized = adminJson(payload);
assert.ok(!serialized.includes('proof-value') && !serialized.includes('signature-value') && !serialized.includes('secret-value'));
assert.ok(serialized.includes('safe'));
assert.equal(payload.note_attributes[0].value, 'proof-value');
assert.equal(adminJson('{bad'), '[unparseable_json_string]');
const recent = summarizeRecentOrders(fixtureRows().orders);
assert.equal(recent.total, 2); assert.equal(recent.holds, 1); assert.equal(recent.attention.length, 1);
assert.deepEqual(summarizeRecentOrders([]), { total: 0, active: 0, holds: 0, attention: [] });
assert.equal(summarizeRecentOrders([{ status: 'processing' }, { status: 'failed' }, { status: 'completed', last_error: 'error' }]).active, 1);

const fixture = await startFixtureAdmin();
const headers = { 'x-admin-access-token': fixtureToken };
const lists = ['orders', 'jobs', 'webhooks', 'factory-callbacks', 'artifacts', 'shopify-update-tasks'];
try {
  assert.equal((await fetch(fixture.url + '/admin')).status, 401);
  assert.equal((await fetch(fixture.url + '/admin', { headers: { accept: 'text/html' }, redirect: 'manual' })).headers.get('location'), '/admin/login');
  assert.equal((await fetch(fixture.url + '/admin', { headers: { 'x-admin-access-token': 'wrong' } })).status, 403);
  assert.equal((await fetch(fixture.url + '/admin/login')).status, 200);
  for (const mode of ['normal', 'null', 'long', 'empty']) {
    fixture.setMode(mode);
    for (const route of ['/admin', ...lists.map(x => '/admin/' + x), ...(mode === 'empty' ? [] : lists.map(x => '/admin/' + x + '/1'))]) {
      const response = await fetch(fixture.url + route, { headers });
      const html = await response.text();
      assert.equal(response.status, 200, mode + ' ' + route + ': ' + html.slice(0, 300));
      assert.ok(!/PROOF_MUST_NOT_RENDER|SIGNATURE_MUST_NOT_RENDER|SECRET_MUST_NOT_RENDER|DIGEST_MUST_NOT_RENDER/.test(html), 'Secret leaked: ' + route);
      assert.ok(!html.includes('<script>unsafe()'), 'Unescaped payload');
      assert.ok(!/Local Console|Local environment|Dry-run tasks/.test(html));
      assert.equal((html.match(/<form /g) || []).length, 1, 'Only logout form allowed');
    }
  }
  fixture.setMode('normal');
  const hold = await (await fetch(fixture.url + '/admin/orders/2', { headers })).text();
  assert.match(hold, /SECURITY_HOLD/); assert.match(hold, /Factory processing is blocked/);
  assert.match(hold, /CHECKOUT_PROOF_MISSING/);
  const pass = await (await fetch(fixture.url + '/admin/orders/1', { headers })).text();
  assert.match(pass, /PASS/); assert.match(pass, /enforce/); assert.match(pass, /PRESENT/);
  assert.ok(!pass.includes('Factory processing is blocked'));
  for (const slug of lists) assert.equal((await fetch(fixture.url + '/admin/' + slug + '/999', { headers })).status, 404);
  assert.ok(fixture.queries.every(sql => /^SELECT\s/i.test(sql.trim())));
  fixture.setFailReads(true);
  let readError;
  await DashboardController.index({}, { render() { assert.fail('Failed read must not render'); } }, error => { readError = error; });
  assert.match(readError.message, /Fixture read failure/);
  console.log('admin UI helper, read-only route, null, hold, PASS, escaping and redaction smoke ok');
} finally {
  await fixture.close();
}

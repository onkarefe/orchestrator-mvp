// Synthetic data only. No production records or credentials.
export const fixtureToken = 'admin-ui-fixture-token';
export const longValue = 'long-identifier-'.repeat(150);
const at = new Date('2026-09-24T11:30:10Z');
const payload = { note_attributes: [
  { name: 'wandini_checkout_proof', value: 'PROOF_MUST_NOT_RENDER' },
  { name: 'wandini_checkout_signature', value: 'SIGNATURE_MUST_NOT_RENDER' },
], api_key: 'SECRET_MUST_NOT_RENDER', safe: '<script>unsafe()</script>' };
export function fixtureRows(mode = 'normal') {
  const common = {
    id: 1, order_id: 1, job_id: 1, artifact_id: 1, shopify_order_id: '908715302',
    shopify_line_item_id: '1288331', created_at: at, updated_at: at, received_at: at,
    processed_at: at, completed_at: at, started_at: at, uploaded_at: at,
    status: 'completed', attempt_count: 1, max_attempts: 3, processing_status: 'processed',
    headers_json: { authorization: 'SECRET_MUST_NOT_RENDER' }, raw_payload_json: payload,
  };
  const rows = {
    orders: [{ ...common, shopify_order_number: '#1042', customer_name: 'Sample Customer',
      customer_email: 'customer@example.test', financial_status: 'paid', factory_status: 'shipped',
      factory_order_id: 'NEXO-1042', checkout_security_json: { result: 'PASS', mode: 'enforce',
        reason: null, detectedAt: at.toISOString(), sourceName: 'note_attributes', proofDigest: 'DIGEST_MUST_NOT_RENDER' } },
      { ...common, id: 2, shopify_order_number: '#1043', status: 'SECURITY_HOLD',
        checkout_security_json: { result: 'FAIL', mode: 'enforce', reason: 'CHECKOUT_PROOF_MISSING', detectedAt: at.toISOString() } }],
    jobs: [{ ...common, product_title: 'Forest wallpaper', sku: '20-140.1-3', width_mm: 2400, height_mm: 2600,
      artifact_manifest_path: '/artifacts/1042/manifest.json', factory_reference: 'WANDINI-1042', nexo_status: 'shipped' }],
    webhooks: [{ ...common, topic: 'orders/paid', hmac_valid: 1, delivery_id: 'shopify-delivery-1042', provider: 'shopify' }],
    artifacts: [{ ...common, status: 'available', type: 'zip', file_name: '1042.zip',
      file_path: '/artifacts/1042/1042.zip', manifest_path: '/artifacts/1042/manifest.json',
      checksum: 'e'.repeat(64), validation_status: 'valid', file_count: 3, file_size: 2048, total_size_bytes: 2048, download_count: 0 }],
    factory_callbacks: [{ ...common, status: 'shipped', auth_valid: 1, provider: 'nexo',
      factory_reference: 'WANDINI-1042', factory_order_id: 'NEXO-1042', delivery_id: 'nexo-delivery-1042', tracking_count: 1 }],
    shopify_update_tasks: [{ ...common, task_type: 'fulfillment', dry_run: 0, external_id: 'gid://shopify/Fulfillment/42', payload_json: payload, result_json: { outcome: 'completed' } }],
    order_line_items: [{ ...common, title: 'Forest wallpaper', sku: '20-140.1-3', quantity: 1,
      source_position: 0, classification: 'WALLPAPER', routing_state: 'production_ready' }],
    order_factory_packages: [{ ...common, status: 'ready', order_number: '1042', nexo_order_id: 'NEXO-1042',
      factory_status: 'shipped', content_checksum: 'e'.repeat(64) }],
    factory_upload_tasks: [{ ...common, status: 'uploaded', remote_dir: '/factory/1042',
      uploaded_files_json: [{ file_name: '1042.pdf', status: 'renamed' }] }],
    logs: [{ ...common, level: 'info', step: 'processing.completed', message: 'Production completed' }],
  };
  if (mode === 'empty') return Object.fromEntries(Object.keys(rows).map(k => [k, []]));
  if (mode === 'null') return Object.fromEntries(Object.keys(rows).map(k => [k, [{ id: 1 }]]));
  if (mode === 'long') {
    for (const records of Object.values(rows)) for (const row of records) {
      for (const key of ['shopify_order_id', 'shopify_line_item_id', 'delivery_id', 'checksum', 'content_checksum',
        'file_path', 'manifest_path', 'artifact_manifest_path', 'last_error', 'error_message',
        'manual_review_reason', 'factory_reference', 'factory_order_id', 'external_id', 'locked_by', 'idempotency_key']) row[key] = longValue;
      row.file_name = longValue + '.pdf';
      row.raw_payload_json = { ...payload, diagnostic: longValue };
    }
  }
  return rows;
}

export async function startFixtureAdmin(mode = 'normal') {
  const [{ default: pool }, { default: env }, { default: app }] = await Promise.all([
    import('../../src/db/connection.js'), import('../../src/config/env.js'), import('../../src/app.js'),
  ]);
  let rows = fixtureRows(mode);
  let failReads = false;
  const queries = [];
  const saved = { query: pool.query, execute: pool.execute, getConnection: pool.getConnection,
    enabled: env.ADMIN_ACCESS_ENABLED, token: env.ADMIN_ACCESS_TOKEN };
  const read = async (sql, params = []) => {
    queries.push(sql);
    if (!/^SELECT\s/i.test(sql.trim())) throw new Error('Admin attempted a database mutation');
    if (failReads) throw new Error('Fixture read failure');
    const table = sql.match(/\bFROM\s+([a-z_]+)/i)?.[1];
    if (!Object.hasOwn(rows, table)) throw new Error('Unexpected fixture query: ' + sql);
    let result = rows[table];
    if (/WHERE id = \?/i.test(sql)) result = result.filter(row => String(row.id) === String(params[0]));
    return [result];
  };
  pool.query = pool.execute = read;
  pool.getConnection = async () => { throw new Error('Unexpected database connection'); };
  env.ADMIN_ACCESS_ENABLED = true;
  env.ADMIN_ACCESS_TOKEN = fixtureToken;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port, queries,
    setMode(value) { rows = fixtureRows(value); },
    setFailReads(value) { failReads = value; },
    async close() {
      await new Promise(resolve => server.close(resolve));
      pool.query = saved.query; pool.execute = saved.execute; pool.getConnection = saved.getConnection;
      env.ADMIN_ACCESS_ENABLED = saved.enabled; env.ADMIN_ACCESS_TOKEN = saved.token;
    },
  };
}

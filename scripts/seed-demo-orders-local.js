import 'dotenv/config';
import mysql from 'mysql2/promise';

const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'orchestrator_mvp',
});

async function columns(table) {
  const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
  return new Set(rows.map((r) => r.Field));
}

async function insertFlexible(table, data) {
  const cols = await columns(table);
  const payload = Object.fromEntries(
    Object.entries(data).filter(([key, value]) => cols.has(key) && value !== undefined),
  );

  const keys = Object.keys(payload);
  const values = Object.values(payload);

  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;

  const [result] = await db.execute(sql, values);
  return result.insertId;
}

const now = new Date();

const demos = [
  {
    order: {
      shopify_order_id: 'demo-1001',
      shopify_order_name: '#DEMO-1001',
      order_name: '#DEMO-1001',
      customer_email: 'anna.demo@example.com',
      email: 'anna.demo@example.com',
      customer_name: 'Anna Keller',
      status: 'queued',
      raw_payload: JSON.stringify({demo: true, type: 'large-wall-mural'}),
      created_at: now,
      updated_at: now,
    },
    job: {
      shopify_line_item_id: 'demo-line-1001',
      product_title: 'Golden Koi Harmony Wall Mural',
      variant_title: 'Premium',
      master_asset_id: 'tryout1',
      width_mm: 3000,
      height_mm: 1250,
      status: 'pending',
      attempt_count: 0,
      payload: JSON.stringify({
        version: 1,
        master_asset_id: 'tryout1',
        output: {unit: 'mm', width: 3000, height: 1250},
        crop_ratio: {x: 0, y: 0.3742, w: 1, h: 0.6257},
      }),
      created_at: now,
      updated_at: now,
    },
  },
  {
    order: {
      shopify_order_id: 'demo-1002',
      shopify_order_name: '#DEMO-1002',
      order_name: '#DEMO-1002',
      customer_email: 'marco.demo@example.com',
      email: 'marco.demo@example.com',
      customer_name: 'Marco Weiss',
      status: 'processing',
      raw_payload: JSON.stringify({demo: true, type: 'medium-bedroom-wall'}),
      created_at: now,
      updated_at: now,
    },
    job: {
      shopify_line_item_id: 'demo-line-1002',
      product_title: 'Misty Forest Panorama',
      variant_title: 'Standard',
      master_asset_id: 'forest-demo',
      width_mm: 2100,
      height_mm: 900,
      status: 'processing',
      attempt_count: 1,
      payload: JSON.stringify({
        version: 1,
        master_asset_id: 'forest-demo',
        output: {unit: 'mm', width: 2100, height: 900},
        crop_ratio: {x: 0.12, y: 0.08, w: 0.76, h: 0.55},
      }),
      started_at: now,
      created_at: now,
      updated_at: now,
    },
  },
  {
    order: {
      shopify_order_id: 'demo-1003',
      shopify_order_name: '#DEMO-1003',
      order_name: '#DEMO-1003',
      customer_email: 'sofia.demo@example.com',
      email: 'sofia.demo@example.com',
      customer_name: 'Sofia Berg',
      status: 'failed',
      raw_payload: JSON.stringify({demo: true, type: 'failed-missing-master'}),
      created_at: now,
      updated_at: now,
    },
    job: {
      shopify_line_item_id: 'demo-line-1003',
      product_title: 'Abstract Marble Texture',
      variant_title: 'Economy',
      master_asset_id: 'missing-demo-master',
      width_mm: 1600,
      height_mm: 2400,
      status: 'failed',
      attempt_count: 2,
      last_error: 'Demo error: master image file not found',
      payload: JSON.stringify({
        version: 1,
        master_asset_id: 'missing-demo-master',
        output: {unit: 'mm', width: 1600, height: 2400},
        crop_ratio: {x: 0.2, y: 0, w: 0.6, h: 1},
      }),
      created_at: now,
      updated_at: now,
    },
  },
];

for (const demo of demos) {
  const orderId = await insertFlexible('orders', demo.order);
  const jobId = await insertFlexible('jobs', {...demo.job, order_id: orderId});

  await insertFlexible('logs', {
    order_id: orderId,
    job_id: jobId,
    level: 'info',
    event: 'demo.seeded',
    message: `Demo order seeded for UI: ${demo.order.shopify_order_name || demo.order.order_name}`,
    context: JSON.stringify({demo: true}),
    created_at: now,
  });
}

await db.end();
console.log('Seed tamam: 3 demo order + job + log oluşturuldu.');

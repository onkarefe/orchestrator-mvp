import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from '../src/config/paths.js';
import pool from '../src/db/connection.js';
import { buildOrderXml } from '../src/processing/xml.js';
import { buildWallpaperPanelFileName } from '../src/processing/factoryFileNames.js';
import { assembleOrderFactoryPackage, inspectOrderFactoryReadiness, ORDER_FACTORY_PACKAGE_SCHEMA } from '../src/processing/OrderFactoryPackageAssembler.js';
import { ensureOrderFactoryPackage } from '../src/services/OrderFactoryPackageService.js';
import { extractPdfFileNamesFromXml, resolveFactoryUploadFiles, processClaimedFactoryUploadTask, processFactoryUploadTaskById } from '../src/services/FactoryUploadService.js';

// SANITIZED SYNTHETIC fixtures. Reference order IDs and totals are supplied facts;
// line IDs, SKUs, addresses, render manifests and PDF bytes are invented.
// A unique local directory is required under artifactsDir for the real upload
// worker's unchanged path gate. No existing artifacts are read or modified.
await fs.mkdir(artifactsDir, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(artifactsDir, '.financial-xml-smoke-'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const money = amount => ({ presentment_money: { currency_code: 'EUR', amount }, shop_money: { currency_code: 'EUR', amount } });
const source = (id, sku, price, quantity = 1) => ({ id, sku, price_set: money(price), quantity, discount_allocations: [], tax_lines: [] });
let sequence = 50000;
function fixture(items, total, shopifyId = String(++sequence)) {
  const order = {
    id: ++sequence, shopify_order_id: shopifyId, status: 'processing',
    raw_payload_json: {
      id: shopifyId, currency: 'EUR', presentment_currency: 'EUR', financial_status: 'paid', taxes_included: true,
      payment_gateway_names: ['shopify_payments'], source_name: 'shopify_draft_order',
      total_price_set: money(total), total_shipping_price_set: money('0.00'), shipping_lines: [],
      line_items: items, shipping_address: { name: 'Synthetic', address1: 'Test 1', zip: '12345', city: 'Berlin', country_code: 'DE' },
    },
  };
  const positions = items.map((item, index) => ({
    classification: item.sku.startsWith('283-') ? 'ACCESSORY' : 'WALLPAPER',
    shopifyLineItemId: String(item.id), sourcePosition: index, sku: item.sku, quantity: item.quantity,
    panelFiles: item.sku.startsWith('283-') ? [] : Array.from({ length: 4 }, (_, panel) => ({
      fileName: buildWallpaperPanelFileName({ shopifyOrderId: shopifyId, sourcePosition: index, panelNumber: panel + 1 }),
      widthMm: 555, heightMm: 2220,
    })),
  }));
  const lineItems = positions.map(p => ({
    id: p.sourcePosition + 1, order_id: order.id, shopify_order_id: shopifyId,
    shopify_line_item_id: p.shopifyLineItemId, source_position: p.sourcePosition,
    sku: p.sku, quantity: p.quantity, classification: p.classification, routing_state: 'production_ready',
  }));
  return { order, positions, lineItems };
}
const xmlFor = f => buildOrderXml({ order: f.order, shopifyOrderId: f.order.shopify_order_id, positions: f.positions });
const bodies = xml => [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(match => match[1]);
const prices = xml => [...xml.matchAll(/<total_price>([^<]+)<\/total_price>/g)].map(match => match[1]);
async function assembly(f) {
  const renderRoot = path.join(tempRoot, `render-${f.order.id}`);
  await fs.mkdir(renderRoot, { recursive: true });
  for (const position of f.positions) {
    for (const panel of position.panelFiles) {
      panel.sourcePath = path.join(renderRoot, panel.fileName);
      await fs.writeFile(panel.sourcePath, `%PDF synthetic ${panel.fileName}\n`, { flag: 'wx' });
    }
  }
  return assembleOrderFactoryPackage({ order: f.order, positions: f.positions, artifactsRoot: tempRoot });
}
const uploadArgs = a => ({ artifact: { manifest_path: a.manifestPath, checksum: a.xmlChecksum }, orderPackage: { content_checksum: a.contentChecksum }, artifactsRoot: tempRoot });
async function snapshot(dir) {
  const names = (await fs.readdir(dir)).sort();
  return Promise.all(names.map(async name => {
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath);
    return [name, stat.mtimeMs, sha(await fs.readFile(filePath))];
  }));
}
let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed++; }
  catch (error) { failed++; console.error(`FAIL: ${name}`); console.error(error); }
}
function accessoryFixture(quantity = 1) {
  return fixture([source('101', '283-388.0', '32.46', quantity)], ['0.00', '32.46', '64.92', '97.38'][quantity]);
}
function runtimeFor(f) {
  const logs = [];
  const unexpected = async () => assert.fail('No persistence, upload scheduling or cleanup is allowed');
  return {
    logs,
    getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }),
    findOrderByIdForUpdate: async () => f.order,
    listOrderLineItemsByOrderId: async () => f.lineItems,
    findOrderFactoryPackageByOrderId: async () => null,
    listJobsByOrderId: async () => [], listArtifactsByOrderId: async () => [],
    inspectOrderFactoryReadiness: input => inspectOrderFactoryReadiness({ ...input, artifactsRoot: tempRoot }),
    assembleOrderFactoryPackage: input => assembleOrderFactoryPackage({ ...input, artifactsRoot: tempRoot }),
    createArtifact: unexpected, createOrderFactoryPackage: unexpected,
    ensureOrderFactoryUploadTask: unexpected, updateOrderStatus: unexpected,
    removeAssembledOrderFactoryPackage: unexpected,
    logInfo: async entry => logs.push(entry), logWarning: async entry => logs.push(entry),
  };
}

try {
  const references = [
    ['8482023506258', ['58.88', '239.85', '32.46'], '331.19'],
    ['8482039497042', ['32.46', '52.00', '342.90', '263.25'], '690.61'],
    ['8482051785042', ['52.68', '234.00', '48.75'], '335.43'],
    ['8482267791698', ['192.21', '175.26', '32.46'], '399.93'],
  ];
  for (const [id, totals, total] of references) await test(`synthetic reference XML ${id}`, () => {
    const f = fixture(totals.map((value, index) => source(String(19647761088850n + BigInt(index)), index === totals.length - 1 ? '283-388.0' : '20-140.1-3', value)), total, id);
    const original = structuredClone(f);
    f.positions.reverse();
    const xml = xmlFor(f);
    assert.deepEqual(prices(xml), totals); // Same-SKU wallpapers still have separate totals.
    assert.equal(bodies(xml).length, totals.length);
    assert.match(xml, /<shipping_type>Standard<\/shipping_type>\s*<shipping_costs>0.00<\/shipping_costs>\s*<payment_method>Shopify Payments<\/payment_method>/);
    assert.ok(!/<price\b/.test(xml));
    assert.match(xml, new RegExp(`<order_number>WANDINI-S${id}</order_number>`));
    assert.ok(!xml.includes('<reference>'));
    for (const [index, body] of bodies(xml).entries()) {
      assert.match(body, /<copies_per_variant>1<\/copies_per_variant>\s*<total_price>\d+\.\d{2}<\/total_price>\s*<files/);
      if (index < totals.length - 1) {
        assert.match(body, /<width unit="mm">555<\/width>\s*<height unit="mm">2220<\/height>\s*<variants>4<\/variants>/);
        assert.deepEqual(extractPdfFileNamesFromXml(`<positions><position>${body}</position></positions>`), original.positions[index].panelFiles.map(p => p.fileName));
      }
    }
    assert.deepEqual(f.order, original.order);
    assert.deepEqual(f.positions, [...original.positions].reverse());
  });
  for (const quantity of [1, 2, 3]) await test(`exact accessory structure quantity ${quantity}`, async () => {
    const f = accessoryFixture(quantity);
    const a = await assembly(f);
    const xml = await fs.readFile(a.xmlPath, 'utf8');
    const total = ['0.00', '32.46', '64.92', '97.38'][quantity];
    assert.equal(bodies(xml).length, 1);
    assert.equal(bodies(xml)[0].trim(), `<sku>283-388.0</sku>
      <width unit="mm">0</width>
      <height unit="mm">0</height>
      <variants>1</variants>
      <copies_per_variant>${quantity}</copies_per_variant>
      <total_price>${total}</total_price>
      <files/>`);
    assert.deepEqual(extractPdfFileNamesFromXml(xml), []);
    assert.equal(a.manifest.contents.position_count, 1);
    assert.equal(a.manifest.contents.pdf_count, 0);
    assert.equal(a.manifest.contents.positions[0].quantity, quantity);
    assert.deepEqual((await resolveFactoryUploadFiles(uploadArgs(a))).pdfFiles, []);
    const before = await snapshot(a.packageDir);
    const recovered = await assembleOrderFactoryPackage({ order: f.order, positions: f.positions, artifactsRoot: tempRoot });
    assert.equal(recovered.recoveredExisting, true);
    assert.equal(recovered.contentChecksum, a.contentChecksum);
    assert.deepEqual(await snapshot(a.packageDir), before);
  });
  await test('separate identical accessory SKUs retain identity and source order', async () => {
    const f = fixture([source('101', '283-388.0', '32.46', 3), source('102', '283-388.0', '10.00')], '107.38');
    const ready = await inspectOrderFactoryReadiness({ order: f.order, lineItems: [...f.lineItems].reverse(), jobs: [], artifacts: [], artifactsRoot: tempRoot });
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.positions.map(p => [p.shopifyLineItemId, p.sourcePosition, p.quantity]), [['101', 0, 3], ['102', 1, 1]]);
    const a = await assembly({ ...f, positions: ready.positions });
    assert.equal(a.manifest.contents.position_count, 2);
    assert.equal(a.manifest.contents.pdf_count, 0);
    assert.deepEqual(prices(await fs.readFile(a.xmlPath, 'utf8')), ['97.38', '10.00']);
  });
  await test('shipping, allocated discounts and actual taxes flow only from resolver', () => {
    const f = fixture([source('101', '20-140.1-3', '100.00')], '111.86');
    Object.assign(f.order.raw_payload_json, {
      taxes_included: false, payment_gateway_names: ['paypal_express'], total_shipping_price_set: money('5.00'),
      shipping_lines: [{ price: '5.00', discounted_price: '4.00', discount_allocations: [{ amount: '1.00' }], tax_lines: [{ price: '0.76' }] }],
    });
    Object.assign(f.order.raw_payload_json.line_items[0], { discount_allocations: [{ amount: '10.00' }], tax_lines: [{ price: '17.10' }], properties: [{ name: 'priceOverride', value: '0.01' }] });
    f.positions[0].totalPrice = '0.01'; // Caller-supplied prices are ignored.
    const xml = xmlFor(f);
    assert.deepEqual(prices(xml), ['107.10']);
    assert.match(xml, /<shipping_costs>4.76<\/shipping_costs>\s*<payment_method>PayPal<\/payment_method>/);
  });
  for (const [name, change] of [
    ['missing ID', f => { delete f.positions[0].shopifyLineItemId; }],
    ['wrong ID', f => { f.positions[0].shopifyLineItemId = '999'; }],
    ['missing source position', f => { delete f.positions[0].sourcePosition; }],
    ['wrong source position', f => { f.positions[0].sourcePosition = 1; }],
    ['string source position', f => { f.positions[0].sourcePosition = '0'; }],
    ['wrong SKU', f => { f.positions[0].sku = '283-391.0'; }],
    ['wrong quantity', f => { f.positions[0].quantity = 2; }],
    ['missing classification', f => { delete f.positions[0].classification; }],
    ['unknown classification', f => { f.positions[0].classification = 'UNKNOWN'; }],
    ['duplicate position', f => { f.positions.push({ ...f.positions[0] }); }],
  ]) await test(`serialization rejects ${name}`, async () => {
    const f = accessoryFixture(); change(f);
    assert.throws(() => xmlFor(f), { code: 'factory_financial_position_mismatch' });
    await assert.rejects(assembleOrderFactoryPackage({ order: f.order, positions: f.positions, artifactsRoot: tempRoot }), { code: 'factory_financial_position_mismatch' });
    await assert.rejects(fs.access(path.join(tempRoot, 'orders', `order-${f.order.id}`)), { code: 'ENOENT' });
  });
  await test('complete identity set, not array order or SKU', () => {
    const f = fixture([source('101', '283-388.0', '32.46'), source('102', '283-388.0', '10.00')], '42.46');
    f.positions[0].sourcePosition = 1; f.positions[1].sourcePosition = 0;
    assert.throws(() => xmlFor(f), { code: 'factory_financial_position_mismatch' });
    f.positions = [f.positions[0]];
    assert.throws(() => xmlFor(f), { code: 'factory_financial_position_mismatch' });
    f.positions = [{ ...f.positions[0], sourcePosition: 0 }, { ...f.positions[0], sourcePosition: 0 }];
    assert.throws(() => xmlFor(f), { code: 'factory_financial_position_mismatch' });
  });
  await test('order identity mismatch rejected', () => {
    const f = accessoryFixture(); f.order.raw_payload_json.id = '999';
    assert.throws(() => xmlFor(f), { code: 'factory_financial_order_identity_mismatch' });
  });
  for (const [name, change, code] of [
    ['missing price', f => { delete f.order.raw_payload_json.line_items[0].price_set; }, 'FINANCIAL_MISSING_MONEY'],
    ['unpaid order', f => { f.order.raw_payload_json.financial_status = 'pending'; }, 'FINANCIAL_ORDER_NOT_PAID'],
    ['total mismatch', f => { f.order.raw_payload_json.total_price_set = money('0.00'); }, 'FINANCIAL_RECONCILIATION_MISMATCH'],
    ['missing gateway', f => { f.order.raw_payload_json.payment_gateway_names = []; }, 'FINANCIAL_MISSING_PAYMENT_PROVIDER'],
  ]) await test(`financial ${name} blocks readiness, assembly and task creation`, async () => {
    const f = accessoryFixture(); change(f);
    const ready = await inspectOrderFactoryReadiness({ order: f.order, lineItems: f.lineItems, jobs: [], artifacts: [], artifactsRoot: tempRoot });
    assert.deepEqual(ready, { ready: false, reason: 'factory_financial_data_invalid', details: { financialErrorCode: code } });
    await assert.rejects(assembleOrderFactoryPackage({ order: f.order, positions: f.positions, artifactsRoot: tempRoot }), { code: 'factory_financial_data_invalid', financialErrorCode: code });
    const runtime = runtimeFor(f);
    const result = await ensureOrderFactoryPackage({ orderId: f.order.id, runtime });
    assert.equal(result.reason, 'factory_financial_data_invalid');
    assert.equal(result.financialErrorCode, code);
    assert.equal(result.task, null);
    assert.deepEqual(runtime.logs[0].detailsJson, { reason: 'factory_financial_data_invalid', financialErrorCode: code });
    await assert.rejects(fs.access(path.join(tempRoot, 'orders', `order-${f.order.id}`)), { code: 'ENOENT' });
  });
  await test('financial failure between readiness and assembly is safely reported', async () => {
    const f = accessoryFixture();
    const runtime = runtimeFor(f);
    runtime.assembleOrderFactoryPackage = input => {
      f.order.raw_payload_json.payment_gateway_names = ['PRIVATE_TOKEN'];
      return assembleOrderFactoryPackage({ ...input, artifactsRoot: tempRoot });
    };
    const result = await ensureOrderFactoryPackage({ orderId: f.order.id, runtime });
    assert.equal(result.reason, 'factory_financial_data_invalid');
    assert.equal(result.financialErrorCode, 'FINANCIAL_UNSUPPORTED_PAYMENT_PROVIDER');
    assert.equal(result.task, null);
    assert.deepEqual(runtime.logs[0].detailsJson, { reason: 'factory_financial_data_invalid', financialErrorCode: result.financialErrorCode });
    assert.ok(!JSON.stringify(runtime.logs).includes('PRIVATE_TOKEN'));
    await assert.rejects(fs.access(path.join(tempRoot, 'orders', `order-${f.order.id}`)), { code: 'ENOENT' });
  });

  const validAccessory = bodies(xmlFor(accessoryFixture(2)))[0];
  const wallpaperFixture = fixture([source('101', '20-140.1-3', '100.00')], '100.00');
  const validWallpaper = bodies(xmlFor(wallpaperFixture))[0];
  for (const [name, invalid] of [
    ['zero quantity', validAccessory.replace('<copies_per_variant>2', '<copies_per_variant>0')],
    ['fractional quantity', validAccessory.replace('<copies_per_variant>2', '<copies_per_variant>1.5')],
    ['unsafe quantity', validAccessory.replace('<copies_per_variant>2', '<copies_per_variant>9007199254740992')],
    ['missing price', validAccessory.replace(/\s*<total_price>.*?<\/total_price>/, '')],
    ['negative price', validAccessory.replace('64.92', '-64.92')],
    ['wrong dimensions', validAccessory.replace('<width unit="mm">0', '<width unit="mm">1')],
    ['missing variants', validAccessory.replace(/\s*<variants>.*?<\/variants>/, '')],
    ['wrong variants', validAccessory.replace('<variants>1', '<variants>2')],
    ['unexpected files', validAccessory.replace('<files/>', '<files><file type="ftp">a.pdf</file></files>')],
    ['missing files', validAccessory.replace('<files/>', '')],
    ['expanded files', validAccessory.replace('<files/>', '<files></files>')],
    ['missing wallpaper PDFs', validWallpaper.replace(/<files>[\s\S]*?<\/files>/, '<files/>')],
    ['partial wallpaper PDFs', validWallpaper.replace(/<file type="ftp">[^<]+<\/file>/, '')],
    ['wrong file type', validWallpaper.replace('type="ftp"', 'type="http"')],
  ]) await test(`FTP rejects ${name}, alone and within mixed positions`, () => {
    for (const body of [`<position>${invalid}</position>`, `<position>${validWallpaper}</position><position>${invalid}</position>`]) {
      assert.throws(() => extractPdfFileNamesFromXml(`<positions>${body}</positions>`), { code: 'xml_pdf_references_missing' });
    }
  });
  await test('FTP preserves legacy accessories and wallpaper without financial fields', () => {
    assert.deepEqual(extractPdfFileNamesFromXml('<positions><position><sku>283-388.0</sku></position></positions>'), []);
    const legacy = validWallpaper.replace(/\s*<total_price>.*?<\/total_price>/, '');
    assert.deepEqual(extractPdfFileNamesFromXml(`<positions><position>${legacy}</position><position><sku>283-388.0</sku></position></positions>`), wallpaperFixture.positions[0].panelFiles.map(p => p.fileName));
  });
  await test('FTP keeps duplicate PDF and unsafe filename rejection', () => {
    const names = wallpaperFixture.positions[0].panelFiles.map(p => p.fileName);
    assert.throws(() => extractPdfFileNamesFromXml(`<positions><position>${validWallpaper.replace(names[1], names[0])}</position></positions>`), { code: 'duplicate_pdf_reference' });
    for (const name of ['../escape.pdf', '..\\escape.pdf', '&#x2f;escape.pdf', 'wrong.xml']) {
      assert.throws(() => extractPdfFileNamesFromXml(`<positions><position>${validWallpaper.replace(names[0], name)}</position></positions>`), { code: 'invalid_artifact_file_name' });
    }
  });

  const mixed = fixture([source('101', '283-388.0', '32.46', 2), source('102', '20-140.1-3', '192.21'), source('103', '283-391.0', '10.00')], '267.13');
  const mixedAssembly = await assembly(mixed);
  await test('manifest schema, position order, PDF bytes and checksums stay compatible', async () => {
    const a = mixedAssembly;
    assert.equal(a.manifest.schema, ORDER_FACTORY_PACKAGE_SCHEMA);
    assert.equal(a.manifest.version, 1);
    assert.equal(a.manifest.contents.position_count, 3);
    assert.equal(a.manifest.contents.pdf_count, 4);
    assert.deepEqual(a.manifest.contents.positions.map(p => [p.shopify_line_item_id, p.source_position]), [['101', 0], ['102', 1], ['103', 2]]);
    assert.deepEqual(prices(await fs.readFile(a.xmlPath, 'utf8')), ['64.92', '192.21', '10.00']);
    for (const entry of a.manifest.contents.files) {
      const bytes = await fs.readFile(entry.source_path);
      assert.equal(entry.checksum_sha256, sha(bytes));
      assert.equal(entry.size_bytes, bytes.length);
    }
    for (const panel of mixed.positions[1].panelFiles) {
      assert.deepEqual(await fs.readFile(path.join(a.packageDir, panel.fileName)), await fs.readFile(panel.sourcePath));
    }
    assert.equal(a.contentChecksum, sha(a.manifest.contents.files.map(e => `${e.name}:${e.checksum_sha256}`).join('\n')));
    const before = await snapshot(a.packageDir);
    const recovered = await assembleOrderFactoryPackage({ order: mixed.order, positions: [...mixed.positions].reverse(), artifactsRoot: tempRoot });
    assert.equal(recovered.recoveredExisting, true);
    assert.deepEqual(await snapshot(a.packageDir), before);
  });
  await test('missing or altered PDF, altered XML and mismatched content checksums rejected', async () => {
    const a = mixedAssembly;
    const panelPath = a.manifest.contents.files[0].source_path;
    const originalPdf = await fs.readFile(panelPath);
    await fs.writeFile(panelPath, 'tampered synthetic PDF');
    await assert.rejects(resolveFactoryUploadFiles(uploadArgs(a)), { code: 'factory_package_pdf_checksum_mismatch' });
    await fs.writeFile(panelPath, originalPdf);
    await fs.rename(panelPath, `${panelPath}.held`);
    try { await assert.rejects(resolveFactoryUploadFiles(uploadArgs(a)), { code: 'pdf_missing' }); }
    finally { await fs.rename(`${panelPath}.held`, panelPath); }
    const originalXml = await fs.readFile(a.xmlPath);
    await fs.appendFile(a.xmlPath, '<tampered/>');
    await assert.rejects(resolveFactoryUploadFiles(uploadArgs(a)), { code: 'factory_package_xml_checksum_mismatch' });
    await fs.writeFile(a.xmlPath, originalXml);
    await assert.rejects(resolveFactoryUploadFiles({ ...uploadArgs(a), orderPackage: { content_checksum: 'wrong' } }), { code: 'factory_package_content_checksum_mismatch' });
    const originalManifest = await fs.readFile(a.manifestPath);
    const changed = JSON.parse(originalManifest);
    changed.contents.files[0].name = 'unreferenced.pdf';
    await fs.writeFile(a.manifestPath, JSON.stringify(changed));
    await assert.rejects(resolveFactoryUploadFiles(uploadArgs(a)), { code: 'pdf_manifest_entry_missing' });
    await fs.writeFile(a.manifestPath, originalManifest);
    await resolveFactoryUploadFiles(uploadArgs(a));
  });

  for (const quantity of [1, 3]) await test(`legacy orphan quantity ${quantity} remains immutable and FTP compatible`, async () => {
    const f = accessoryFixture(quantity);
    const orderNumber = `WANDINI-S${f.order.shopify_order_id}`;
    const dir = path.join(tempRoot, 'orders', `order-${f.order.id}`, 'factory-packages', orderNumber);
    await fs.mkdir(dir, { recursive: true });
    const xml = `<root><order><order_number>${orderNumber}</order_number></order><positions>${'<position><sku>283-388.0</sku></position>'.repeat(quantity)}</positions></root>\n`;
    const xmlPath = path.join(dir, `${orderNumber}.xml`);
    const entry = { name: `${orderNumber}.xml`, source_path: xmlPath, checksum_sha256: sha(xml), size_bytes: Buffer.byteLength(xml) };
    const contentChecksum = sha(`${entry.name}:${entry.checksum_sha256}`);
    const manifest = {
      schema: ORDER_FACTORY_PACKAGE_SCHEMA, version: 1,
      order: { id: f.order.id, shopify_order_id: f.order.shopify_order_id, order_number: orderNumber },
      package: { content_checksum_sha256: contentChecksum },
      contents: { file_count: 1, pdf_count: 0, position_count: quantity, xml_file_name: entry.name, files: [entry], positions: Array.from({ length: quantity }, () => ({ source_position: 0, shopify_line_item_id: '101', sku: '283-388.0', quantity: 1, panels: [] })) },
      validation: { ok: true, validationStatus: 'passed' },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(xmlPath, xml); await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const before = await snapshot(dir);
    const args = { artifact: { manifest_path: manifestPath, checksum: entry.checksum_sha256 }, orderPackage: { content_checksum: contentChecksum }, artifactsRoot: tempRoot };
    assert.deepEqual((await resolveFactoryUploadFiles(args)).pdfFiles, []);
    await assert.rejects(assembleOrderFactoryPackage({ order: f.order, positions: f.positions, artifactsRoot: tempRoot }), new RegExp(quantity === 1 ? 'order_factory_package_orphan_xml_mismatch' : 'order_factory_package_orphan_identity_mismatch'));
    assert.deepEqual(await snapshot(dir), before);
    const runtime = runtimeFor(f);
    const blocked = await ensureOrderFactoryPackage({ orderId: f.order.id, runtime });
    assert.match(blocked.reason, /^order_factory_package_orphan_/);
    assert.equal(blocked.task, null);
    assert.deepEqual(await snapshot(dir), before);

    // Persisted legacy package reuse bypasses new financial validation and assembly.
    delete f.order.raw_payload_json.total_price_set;
    const task = { id: 700, order_id: f.order.id, job_id: null, artifact_id: 600, order_factory_package_id: 500, shopify_order_id: f.order.shopify_order_id, factory_reference: orderNumber, upload_mode: 'files', status: 'uploaded' };
    const artifact = { ...args.artifact, id: 600, order_id: f.order.id, job_id: null, type: 'factory_package', status: 'available', validation_status: 'passed', file_name: entry.name };
    const orderPackage = { id: 500, order_id: f.order.id, artifact_id: 600, order_number: orderNumber, status: 'ready', manifest_path: manifestPath, xml_file_name: entry.name };
    f.order.status = 'completed';
    Object.assign(runtime, {
      findOrderFactoryPackageByOrderId: async () => orderPackage, findArtifactById: async () => artifact,
      inspectOrderFactoryReadiness: async () => assert.fail('Legacy reuse must not revalidate finances'),
      assembleOrderFactoryPackage: async () => assert.fail('Legacy reuse must not reassemble'),
      findFactoryUploadTaskByOrderPackageId: async () => task,
      createFactoryUploadTask: async () => assert.fail('Uploaded legacy task must not be recreated'),
    });
    delete runtime.ensureOrderFactoryUploadTask; // Exercise the real existing-task lookup.
    const reused = await ensureOrderFactoryPackage({ orderId: f.order.id, runtime });
    assert.equal(reused.created, false); assert.equal(reused.taskCreated, false);
    assert.equal(reused.task, task); assert.equal(task.status, 'uploaded');
    assert.deepEqual(await snapshot(dir), before);
  });

  await test('real upload worker finalizes XML last and never resends uploaded tasks', async () => {
    const a = mixedAssembly;
    const artifact = { id: 600, order_id: mixed.order.id, job_id: null, type: 'factory_package', status: 'available', validation_status: 'passed', manifest_path: a.manifestPath, checksum: a.xmlChecksum, file_name: a.xmlFileName };
    const orderPackage = { id: 500, order_id: mixed.order.id, artifact_id: 600, order_number: a.orderNumber, status: 'ready', package_dir: a.packageDir, manifest_path: a.manifestPath, xml_file_name: a.xmlFileName, content_checksum: a.contentChecksum };
    const task = { id: 700, order_id: mixed.order.id, job_id: null, artifact_id: 600, order_factory_package_id: 500, shopify_order_id: mixed.order.shopify_order_id, factory_reference: a.orderNumber, upload_mode: 'files', status: 'uploading', locked_by: 'synthetic-worker', uploaded_files_json: [] };
    const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection };
    const calls = [];
    const ftp = {
      connect: async () => {}, close() {}, fileExists: async () => false,
      uploadTemporary: async (filePath, name) => {
        assert.ok((await fs.stat(filePath)).isFile()); calls.push(['upload', name]);
        return { temporaryFileName: `${name}.uploading`, finalFileName: name };
      },
      renameTemporary: async (temporary, name) => {
        assert.equal(temporary, `${name}.uploading`); calls.push(['rename', name]);
      },
      remotePath: name => `/synthetic/${name}`,
    };
    pool.query = pool.getConnection = async () => assert.fail('Unexpected live database access');
    pool.execute = async (sql, params) => {
      if (/^SELECT \* FROM orders WHERE/.test(sql)) return [[mixed.order]];
      if (/^SELECT \* FROM artifacts WHERE/.test(sql)) return [[artifact]];
      if (/^SELECT \* FROM order_factory_packages WHERE/.test(sql)) return [[orderPackage]];
      if (/SELECT \* FROM order_line_items/.test(sql)) return [mixed.lineItems];
      if (/^SELECT \* FROM factory_upload_tasks WHERE/.test(sql)) return [[task]];
      if (/^INSERT INTO logs/.test(sql)) return [{ insertId: 1 }];
      if (/^SELECT \* FROM logs WHERE/.test(sql)) return [[{ id: 1 }]];
      if (/^UPDATE factory_upload_tasks\s+SET uploaded_files_json/.test(sql)) {
        task.uploaded_files_json = JSON.parse(params[0]); return [{ affectedRows: 1 }];
      }
      if (/^UPDATE factory_upload_tasks/.test(sql) && sql.includes('uploaded_at = CURRENT_TIMESTAMP')) {
        assert.equal(calls.at(-1)[1], a.xmlFileName);
        task.status = 'uploaded'; return [{ affectedRows: 1 }];
      }
      assert.fail(`Unexpected mock SQL: ${sql}`);
    };
    try {
      const config = { FTP_UPLOAD_ENABLED: true, FTP_UPLOAD_MODE: 'files', FTP_PROTOCOL: 'ftp', FTP_HOST: 'synthetic.invalid', FTP_USERNAME: 'test', FTP_PASSWORD: 'test', FTP_REMOTE_DIR: '/synthetic', FTP_TEMP_SUFFIX: '.uploading', FTP_PASSIVE: true };
      const result = await processClaimedFactoryUploadTask({ task, workerId: 'synthetic-worker', config, ftpClientFactory: async () => ftp });
      assert.equal(result.disposition, 'uploaded');
      const names = [...mixed.positions[1].panelFiles.map(p => p.fileName), a.xmlFileName];
      assert.deepEqual(calls, names.flatMap(name => [['upload', name], ['rename', name]]));
      const repeated = await processFactoryUploadTaskById(task.id, { workerId: 'synthetic-worker', config, ftpClientFactory: async () => assert.fail('Uploaded XML must never be resent') });
      assert.equal(repeated.disposition, 'uploaded');
      assert.equal(calls.length, names.length * 2);
    } finally { Object.assign(pool, original); }
  });
} finally {
  const resolved = path.resolve(tempRoot);
  assert.equal(path.dirname(resolved), path.resolve(artifactsDir));
  assert.ok(path.basename(resolved).startsWith('.financial-xml-smoke-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
console.log(`Factory financial XML smoke tests: ${passed} passed; ${failed} failed (synthetic fixtures; mocked DB/FTP).`);
if (failed) process.exitCode = 1;

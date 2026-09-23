import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pool from '../src/db/connection.js';
import env from '../src/config/env.js';
import { CHECKOUT_FIELDS, buildCheckoutProof, canonicalCheckoutProof, canonicalMoney, evaluateCheckoutSecurity, checkoutGateMode } from '../src/services/CheckoutSecurityService.js';
import { classifyShopifyLineItem } from '../src/services/LineItemRoutingService.js';
import { createOrderAndJobsFromShopifyPayload } from '../src/services/OrderService.js';
import { ensureOrderFactoryPackage } from '../src/services/OrderFactoryPackageService.js';
import { evaluateFactoryDispatchGate } from '../src/services/FactoryDispatchGateService.js';
import { runPipelineRecovery, reconcileFactoryOrders } from '../src/services/PipelineRecoveryService.js';
import { listOrdersMissingFactoryPackage, listOrdersWithPackageMissingFactoryTask } from '../src/models/PipelineRecoveryModel.js';
import { updateOrderStatus, updateOrderManualReview, updateOrderFactoryState } from '../src/models/OrderModel.js';
import { claimNextPendingJob, claimPendingJobById, releaseStaleProcessingJobs } from '../src/models/JobModel.js';
import { canTransition, isTerminalStatus } from '../src/services/statusTransition.js';
import { validateCheckoutSecurityStartupEnv, getSafeStartupConfigSummary } from '../src/config/startupValidation.js';
import { buildOrderMonitoring } from '../src/services/OrderMonitoringService.js';
import { handleOrdersPaidWebhook } from '../src/controllers/webhook/ShopifyWebhookController.js';

// Public test-only fixture, never a production signing key.
const config = { CHECKOUT_SECURITY_GATE_MODE: 'enforce', WANDINI_CHECKOUT_HMAC_SECRET: 'not-a-production-secret', WALLPAPER_SKUS: ['20-331.1-3'] };
env.WALLPAPER_SKUS = config.WALLPAPER_SKUS;
const accessory = { id: 12, sku: 'accessory', quantity: 1, properties: [] };
function payload() {
  return {
    id: 9001, name: '#9001', financial_status: 'paid', currency: 'EUR', presentment_currency: 'EUR',
    source_name: 'shopify_draft_order',
    shipping_address: { name: 'Fixture', address1: 'Street 1', zip: '12345', city: 'Berlin', country_code: 'DE' },
    line_items: [{
      id: 11, variant_id: 123, sku: '20-331.1-3', quantity: 1, price: '123.40',
      price_set: { shop_money: { amount: '123.40', currency_code: 'EUR' }, presentment_money: { amount: '123.40', currency_code: 'EUR' } },
      total_discount: '0.00', discount_allocations: [],
      properties: [
        { name: '_configurator_instance_id', value: 'instance-1' },
        { name: '_configurator_payload', value: JSON.stringify({
          version: 1, master_asset_id: 'trusted-master',
          output: { width: 3000, height: 2400, unit: 'mm' },
          crop_ratio: { x: 0, y: 0, w: 1, h: 1 },
        }) },
      ],
    }],
  };
}
function sign(order, proof = buildCheckoutProof(order, config)) {
  order.note_attributes = [
    { name: CHECKOUT_FIELDS.version, value: '1' },
    { name: CHECKOUT_FIELDS.proof, value: canonicalCheckoutProof(proof) },
    { name: CHECKOUT_FIELDS.signature, value: createHmac('sha256', config.WANDINI_CHECKOUT_HMAC_SECRET).update(canonicalCheckoutProof(proof)).digest('hex') },
  ];
  return order;
}
function mutatePayload(order, fn) {
  const prop = order.line_items[0].properties[1];
  const data = JSON.parse(prop.value); fn(data); prop.value = JSON.stringify(data);
}
const check = order => evaluateCheckoutSecurity(order, config);
let scenarios = 0;
function test(name, fn) { fn(); scenarios++; }

test('ordinary only', () => assert.equal(check({ line_items: [accessory] }).result, 'NOT_APPLICABLE'));
test('valid signature', () => assert.equal(check(sign(payload())).result, 'PASS'));
test('proof missing despite draft origin', () => assert.equal(check(payload()).reason, 'CHECKOUT_PROOF_MISSING'));
test('signature missing', () => { const p = sign(payload()); p.note_attributes.pop(); assert.equal(check(p).reason, 'CHECKOUT_SIGNATURE_MISSING'); });
test('invalid signature', () => { const p = sign(payload()); p.note_attributes[2].value = '0'.repeat(64); assert.equal(check(p).reason, 'CHECKOUT_SIGNATURE_INVALID'); });
test('short signature', () => { const p = sign(payload()); p.note_attributes[2].value = '00'; assert.equal(check(p).reason, 'CHECKOUT_SIGNATURE_INVALID'); });
test('version', () => { const p = sign(payload()); p.note_attributes[0].value = '2'; assert.equal(check(p).reason, 'CHECKOUT_PROOF_VERSION_UNSUPPORTED'); });
test('malformed', () => { const p = sign(payload()); p.note_attributes[1].value = '{'; assert.equal(check(p).reason, 'CHECKOUT_PROOF_MALFORMED'); });
test('duplicate attributes', () => { const p = sign(payload()); p.note_attributes.push(p.note_attributes[0]); assert.equal(check(p).result, 'FAIL'); });
test('secret absent', () => assert.equal(evaluateCheckoutSecurity(sign(payload()), { ...config, WANDINI_CHECKOUT_HMAC_SECRET: '' }).reason, 'CHECKOUT_SECRET_UNAVAILABLE'));
test('signed price tampered', () => {
  const p = sign(payload()); const proof = JSON.parse(p.note_attributes[1].value);
  proof.lines[0].price = '1'; p.note_attributes[1].value = JSON.stringify(proof);
  assert.equal(check(p).reason, 'CHECKOUT_SIGNATURE_INVALID');
});
for (const [name, change, reason] of [
  ['price', p => { p.line_items[0].price = '1'; }, 'CHECKOUT_PRICE_MISMATCH'],
  ['all prices', p => { const l=p.line_items[0]; l.price='1'; l.price_set.shop_money.amount='1'; l.price_set.presentment_money.amount='1'; }, 'CHECKOUT_PRICE_MISMATCH'],
  ['width', p => mutatePayload(p, v => v.output.width++), 'CHECKOUT_LINE_MISMATCH'],
  ['height', p => mutatePayload(p, v => v.output.height++), 'CHECKOUT_LINE_MISMATCH'],
  ['master', p => mutatePayload(p, v => v.master_asset_id='other'), 'CHECKOUT_LINE_MISMATCH'],
  ['variant', p => { p.line_items[0].variant_id++; }, 'CHECKOUT_LINE_MISMATCH'],
  ['payload', p => mutatePayload(p, v => v.extra='changed'), 'CHECKOUT_LINE_MISMATCH'],
  ['crop', p => mutatePayload(p, v => v.crop_ratio.w=0.5), 'CHECKOUT_LINE_MISMATCH'],
  ['currency', p => { p.currency='USD'; p.presentment_currency='USD'; p.line_items[0].price_set.shop_money.currency_code='USD'; p.line_items[0].price_set.presentment_money.currency_code='USD'; }, 'CHECKOUT_CURRENCY_MISMATCH'],
  ['instance', p => { p.line_items[0].properties[0].value='other'; }, 'CHECKOUT_LINE_MISMATCH'],
  ['quantity', p => { p.line_items[0].quantity=2; }, 'CHECKOUT_LINE_MISMATCH'],
  ['SKU', p => { p.line_items[0].sku='other'; }, 'CHECKOUT_LINE_MISMATCH'],
  ['discount', p => { p.line_items[0].discount_allocations=[{amount:'1.00'}]; }, 'CHECKOUT_PRICE_MISMATCH'],
  ['extra configured line', p => { const l=structuredClone(p.line_items[0]); l.id=13; l.properties[0].value='instance-2'; p.line_items.push(l); }, 'CHECKOUT_LINE_MISMATCH'],
]) test(name, () => { const p=sign(payload()); change(p); assert.equal(check(p).reason, reason, name); });
test('duplicate instance', () => {
  const p=sign(payload()); const l=structuredClone(p.line_items[0]); l.id=13; p.line_items.push(l);
  assert.equal(check(p).reason, 'CHECKOUT_DUPLICATE_INSTANCE');
});
test('mixed orders and order-independent canonicalization', () => {
  const p=payload(); const l=structuredClone(p.line_items[0]); l.id=13; l.properties[0].value='instance-2'; l.variant_id=456;
  p.line_items.push(l, accessory); sign(p); const before=p.note_attributes[2].value;
  p.line_items.reverse(); assert.equal(check(p).result, 'PASS');
  const proof=JSON.parse(p.note_attributes[1].value); proof.lines.reverse();
  p.note_attributes[1].value=JSON.stringify(proof);
  assert.equal(check(p).result, 'PASS'); assert.equal(p.note_attributes[2].value,before);
  // Swapping variant-to-instance assignments is not an ordering change.
  [p.line_items[1].variant_id,p.line_items[2].variant_id]=[p.line_items[2].variant_id,p.line_items[1].variant_id];
  assert.equal(check(p).result,'FAIL');
});
test('decimal money', () => {
  assert.equal(canonicalMoney('9007199254740993.1200'),'9007199254740993.12');
  assert.throws(() => canonicalMoney(123.4)); assert.throws(() => canonicalMoney('1e2'));
});
test('mode safety and terminal state', () => {
  assert.equal(checkoutGateMode({}), 'off');
  assert.throws(() => checkoutGateMode({CHECKOUT_SECURITY_GATE_MODE:'ENFORCE'}));
  assert.throws(() => validateCheckoutSecurityStartupEnv({...config, WANDINI_CHECKOUT_HMAC_SECRET:''}));
  assert.equal(isTerminalStatus('order','SECURITY_HOLD'),true);
  for (const status of ['received','processing','completed','shipped','manual_review']) assert.equal(canTransition('order','SECURITY_HOLD',status),false);
  assert.ok(!JSON.stringify(getSafeStartupConfigSummary(config)).includes(config.WANDINI_CHECKOUT_HMAC_SECRET));
});

// Execute real OrderService + real persistence models against a transaction
// emulator. Unknown SQL fails: no database or external service is contacted.
const originalPool = { getConnection: pool.getConnection, execute: pool.execute, query: pool.query };
const state = { orders: [], lines: [], jobs: [], logs: [], commits:0, released:0, failLogs:false, failDecision:false };
let snapshot;
const clone = structuredClone;
const rows = a => [a.filter(Boolean).map(value => clone(value))];
async function execute(sql, args=[]) {
  sql=sql.replace(/\s+/g,' ').trim();
  if(sql.startsWith('INSERT INTO orders')) {
    if(state.orders.some(o=>String(o.shopify_order_id)===String(args[0]))) throw Object.assign(new Error('duplicate'),{code:'ER_DUP_ENTRY'});
    const o={id:state.orders.length+1,shopify_order_id:String(args[0]),shopify_order_number:args[1],status:args[5],raw_payload_json:JSON.parse(args[7])};
    state.orders.push(o); return [{insertId:o.id}];
  }
  if(sql.startsWith('SELECT * FROM orders WHERE shopify_order_id')) return rows(state.orders.filter(o=>o.shopify_order_id===String(args[0])));
  if(sql.startsWith('SELECT * FROM orders WHERE id')) return rows(state.orders.filter(o=>o.id===args[0]));
  if(sql.startsWith('UPDATE orders SET checkout_proof_digest')) {
    if(args[0] && state.orders.some(o=>o.checkout_proof_digest===args[0] && o.id!==args[1])) throw Object.assign(new Error('duplicate proof'),{code:'ER_DUP_ENTRY'});
    state.orders.find(o=>o.id===args[1]).checkout_proof_digest=args[0]; return [{affectedRows:1}];
  }
  if(sql.startsWith('UPDATE orders SET checkout_security_json')) {
    if(state.failDecision) throw new Error('simulated persistence unavailable');
    const o=state.orders.find(o=>o.id===args[4]); o.checkout_security_json=JSON.parse(args[0]);
    if(args[1]) { o.status='SECURITY_HOLD'; o.manual_review_reason=args[3]; }
    return [{affectedRows:1}];
  }
  if(sql.startsWith('UPDATE orders SET')) {
    const o=state.orders.find(o=>o.id===args.at(-1));
    assert.ok(sql.includes("status <> 'SECURITY_HOLD'"));
    if(o.status!=='SECURITY_HOLD') o.status=args[0];
    return [{affectedRows:o.status==='SECURITY_HOLD'?0:1}];
  }
  if(sql.startsWith('INSERT INTO order_line_items')) {
    const o=state.orders.find(o=>o.id===args[0]);
    assert.notEqual(o.status,'SECURITY_HOLD','line/job persistence after hold');
    const names=['order_id','shopify_order_id','shopify_line_item_id','source_position','sku','title','quantity','classification','routing_state','routing_reason'];
    const l={id:state.lines.length+1,...Object.fromEntries(names.map((n,i)=>[n,args[i]]))};
    state.lines.push(l); return [{insertId:l.id}];
  }
  if(sql.startsWith('SELECT * FROM order_line_items WHERE id')) return rows(state.lines.filter(l=>l.id===args[0]));
  if(sql.startsWith('SELECT * FROM order_line_items WHERE order_id')) return rows(state.lines.filter(l=>l.order_id===args[0]));
  if(sql.startsWith('INSERT INTO logs')) {
    if(state.failLogs) throw new Error('simulated alert unavailable');
    const names=['scope_type','order_id','job_id','level','step','message','details_json'];
    const l={id:state.logs.length+1,...Object.fromEntries(names.map((n,i)=>[n,args[i]]))};
    state.logs.push(l); return [{insertId:l.id}];
  }
  if(sql.startsWith('SELECT * FROM logs')) return rows(state.logs.filter(l=>l.id===args[0]));
  if(sql.startsWith('SELECT * FROM jobs') || sql.startsWith('UPDATE jobs')) {
    assert.ok(sql.includes("o.status = 'SECURITY_HOLD'"),'claim/recovery must exclude held orders');
    return sql.startsWith('SELECT') ? [[]] : [{affectedRows:0}];
  }
  throw new Error('Unexpected test SQL: '+sql);
}
const db = {
  execute, async beginTransaction(){snapshot=clone(state);},
  async commit(){state.commits++;}, async rollback(){Object.assign(state,snapshot);},
  release(){state.released++;},
};
pool.getConnection=async()=>db; pool.execute=execute;
pool.query=async()=>assert.fail('Unexpected live query');
const runtime={
  classifyShopifyLineItem:line=>classifyShopifyLineItem(line,{wallpaperSkus:config.WALLPAPER_SKUS,validationOptions:{checkMasterFileExists:false}}),
  getConnection:async()=>db,
  createConfiguratorJobFromLineItem:async(orderId,line)=>{
    const order=state.orders.find(o=>o.id===orderId);
    assert.notEqual(order.status,'SECURITY_HOLD');
    if(order.checkout_security_json?.mode==='enforce') assert.equal(order.checkout_security_json.result,'PASS');
    const job={id:state.jobs.length+1,order_id:orderId,shopify_line_item_id:line.id,status:'pending'};
    state.jobs.push(job); return {job,created:true};
  },
};
let nextId=9100;
async function intake(order,mode='enforce') {
  order.id=nextId++; return createOrderAndJobsFromShopifyPayload(order,{config:{...config,CHECKOUT_SECURITY_GATE_MODE:mode},runtime});
}
try {
  const ordinary=await intake({...payload(),line_items:[accessory]});
  assert.equal(ordinary.order.checkout_security_json.result,'NOT_APPLICABLE');
  assert.notEqual(ordinary.order.status,'SECURITY_HOLD');
  scenarios++;

  const report=await intake(payload(),'report');
  assert.equal(report.order.checkout_security_json.result,'FAIL');
  assert.equal(report.jobs.length,1);
  assert.ok(state.logs.some(l=>l.step==='checkout.validation'));
  scenarios++;

  const passed=await intake(sign(payload()));
  assert.equal(passed.order.checkout_security_json.result,'PASS');
  assert.equal(passed.jobs.length,1);
  const replay=await intake(sign(payload()));
  assert.equal(replay.order.checkout_security_json.reason,'CHECKOUT_PROOF_REPLAYED');
  assert.equal(replay.jobs.length,0);
  scenarios+=2;

  const off=await intake(payload(),'off');
  assert.equal(off.order.checkout_security_json,undefined); assert.equal(off.jobs.length,1);
  scenarios++;

  const before=state.jobs.length;
  const mixed=payload(); mixed.line_items.push(accessory);
  const held=await intake(mixed);
  assert.equal(held.order.status,'SECURITY_HOLD'); assert.equal(state.jobs.length,before);
  assert.equal(held.lineItems.length,0);
  assert.equal(state.logs.filter(l=>l.step==='checkout.security_hold' && l.order_id===held.order.id).length,1);
  const duplicate=await createOrderAndJobsFromShopifyPayload(mixed,{config,runtime});
  assert.equal(duplicate.duplicate,true); assert.equal(duplicate.order.status,'SECURITY_HOLD');
  assert.equal(state.logs.filter(l=>l.step==='checkout.security_hold' && l.order_id===held.order.id).length,1);
  assert.equal(state.jobs.length,before);
  // Turning mode off cannot release a previously held order.
  assert.equal((await createOrderAndJobsFromShopifyPayload(mixed,{config:{...config,CHECKOUT_SECURITY_GATE_MODE:'off'},runtime})).order.status,'SECURITY_HOLD');
  scenarios+=3;

  for(const fn of [
    ()=>updateOrderStatus(held.order.id,'processing',db),
    ()=>updateOrderManualReview(held.order.id,'other',db),
    ()=>updateOrderFactoryState(held.order.id,{status:'shipped'},db),
  ]) assert.equal((await fn()).status,'SECURITY_HOLD');
  assert.equal(evaluateFactoryDispatchGate({order:held.order,lineItems:[]}).reason,'checkout_security_hold');
  assert.ok(buildOrderMonitoring({order:held.order}).anomalies.some(a=>a.code==='checkout_security_hold'));
  scenarios++;

  const packageRuntime={
    getConnection:async()=>db, findOrderByIdForUpdate:async()=>held.order,
    listOrderLineItemsByOrderId:async()=>assert.fail('Held order reached package work'),
    assembleOrderFactoryPackage:async()=>assert.fail('XML must not be created'),
    ensureOrderFactoryUploadTask:async()=>assert.fail('Factory task must not be created'),
  };
  const blocked=await ensureOrderFactoryPackage({orderId:held.order.id,runtime:packageRuntime});
  assert.equal(blocked.reason,'checkout_security_hold');
  for(const trigger of ['startup','periodic']) {
    const recovery=await runPipelineRecovery({config,runtime:{
      releaseStaleProcessingJobs:async()=>({requeued:0,failed:0}),
      recoverShopifyWebhooks:async()=>({recovered:0}),
      recoverNexoCallbacks:async()=>({recovered:0}),
      reconcileFactoryOrders:()=>reconcileFactoryOrders({config,runtime:{
        listOrdersMissingFactoryPackage:async()=>[held.order.id],
        listOrdersWithPackageMissingFactoryTask:async()=>[held.order.id],
        ensureOrderFactoryPackage:options=>ensureOrderFactoryPackage({...options,runtime:packageRuntime}),
        logWarning:async()=>null,
        logError:async()=>assert.fail('Hold must not cause retry failure'),
      }}),
    }});
    assert.equal(recovery.factory.skipped,1,trigger); assert.equal(recovery.factory.failed,0);
  }
  scenarios+=3;

  for(const fn of [listOrdersMissingFactoryPackage,listOrdersWithPackageMissingFactoryTask]) {
    assert.deepEqual(await fn({db:{query:async(sql)=>{assert.ok(sql.includes("o.status <> 'SECURITY_HOLD'"));return [[]];}}}),[]);
  }
  assert.equal(await claimNextPendingJob(),null); assert.equal(await claimPendingJobById(1),null);
  assert.deepEqual(await releaseStaleProcessingJobs({db}),{requeued:0,failed:0});
  scenarios++;

  state.failLogs=true;
  const oldError=console.error; console.error=()=>{};
  try { const result=await intake(payload()); assert.equal(result.order.status,'SECURITY_HOLD'); }
  finally { console.error=oldError;state.failLogs=false; }
  scenarios++;

  state.failDecision=true;
  const ordersBefore=state.orders.length;
  await assert.rejects(intake(payload()),/simulated persistence unavailable/);
  assert.equal(state.orders.length,ordersBefore); state.failDecision=false;
  scenarios++;

  // HTTP acknowledgement with the real business intake: rejected proof is a
  // successful durable disposition, never a webhook processing exception.
  const requestPayload=payload();requestPayload.id=nextId++;
  const req={rawBody:Buffer.from(JSON.stringify(requestPayload)),headers:{},
    get:name=>({'x-shopify-topic':'orders/paid','x-shopify-shop-domain':'fixture.myshopify.com','x-shopify-webhook-id':'checkout-fixture'}[name])};
  const res={statusCode:0,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  let acknowledged=0;
  await handleOrdersPaidWebhook(req,res,{
    config:{SHOPIFY_WEBHOOK_HMAC_REQUIRED:true,SHOPIFY_WEBHOOK_SECRET:'fixture',SHOPIFY_SHOP_DOMAIN:'fixture.myshopify.com',SHOPIFY_WEBHOOK_MAX_ATTEMPTS:3,SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES:30},
    verifyShopifyWebhookHmac:()=>true,getWebhookWorkerId:()=> 'test',
    getWebhookByDeliveryId:async()=>null,recordWebhook:async()=>({id:1}),
    claimWebhookProcessing:async()=>({id:1}),
    processWebhookOrder:async()=>{const r=await createOrderAndJobsFromShopifyPayload(requestPayload,{config,runtime});acknowledged++;return r;},
    markWebhookFailed:async()=>assert.fail('Security hold must not fail webhook'),logWarning:async()=>null,
  });
  assert.equal(res.statusCode,200);assert.equal(acknowledged,1);scenarios++;
  assert.ok(!JSON.stringify(state).includes(config.WANDINI_CHECKOUT_HMAC_SECRET));
} finally { Object.assign(pool,originalPool); }
console.log('checkout security smoke ok: '+scenarios+' scenarios');


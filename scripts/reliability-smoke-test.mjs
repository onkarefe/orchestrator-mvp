import assert from 'node:assert/strict';
import pool from '../src/db/connection.js';
import { createOrderAndJobsFromShopifyPayload } from '../src/services/OrderService.js';
import { ensureOrderFactoryPackage } from '../src/services/OrderFactoryPackageService.js';
import {
  claimPendingJobById, markJobCompletedWithArtifactManifest, markJobFailed, markJobPendingForRetry,
  publishCompletedJobArtifact,
} from '../src/models/JobModel.js';

// A single checked-out slot is enough to detect the old nested-pool wait.
for (const scenario of ['created', 'duplicate', 'concurrent_duplicate', 'failed', 'begin_failed']) {
  const original = { getConnection: pool.getConnection, execute: pool.execute };
  let held = false;
  let releases = 0;
  let rollbacks = 0;
  const independentCalls = [];
  const failure = new Error('simulated transaction failure');
  const order = { id: 1, shopify_order_id: '9001', status: 'received' };
  const connection = {
    async beginTransaction() { if (scenario === 'begin_failed') throw failure; },
    async commit() {},
    async rollback() { rollbacks += 1; },
    release() { assert.equal(held, true); held = false; releases += 1; },
    async execute(sql) {
      if (sql.includes('shopify_order_id =')) {
        return [[...(scenario === 'duplicate' ? [order] : [])]];
      }
      if (sql.includes('INSERT INTO orders')) {
        if (scenario === 'concurrent_duplicate') {
          throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        }
        if (scenario === 'failed') throw failure;
        return [{ insertId: 1 }];
      }
      if (sql.includes('FROM order_line_items')) return [[]];
      if (sql.startsWith('UPDATE orders')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM orders')) return [[order]];
      throw new Error('Unexpected transaction SQL: ' + sql);
    },
  };
  pool.getConnection = async () => { held = true; return connection; };
  pool.execute = async (sql) => {
    independentCalls.push({ sql, held });
    if (sql.includes('FROM orders')) return [[order]];
    if (sql.includes('FROM order_line_items')) return [[]];
    if (sql.includes('INSERT INTO logs')) return [{ insertId: 1 }];
    if (sql.includes('FROM logs')) return [[{ id: 1 }]];
    throw new Error('Unexpected independent SQL: ' + sql);
  };
  try {
    const operation = createOrderAndJobsFromShopifyPayload({
      id: 9001, line_items: [],
      shipping_address: {
        name: 'Local Test', address1: 'Test 1', zip: '12345', city: 'Berlin', country_code: 'DE',
      },
    });
    if (['failed', 'begin_failed'].includes(scenario)) {
      await assert.rejects(operation, (error) => error === failure);
    } else {
      const result = await operation;
      assert.equal(result.duplicate, scenario !== 'created');
    }
    assert.equal(releases, 1);
    assert.equal(rollbacks, ['failed', 'concurrent_duplicate'].includes(scenario) ? 1 : 0);
    assert.ok(independentCalls.length > 0);
    assert.ok(independentCalls.every((call) => !call.held));
  } finally {
    Object.assign(pool, original);
  }
}

for (const scenario of ['created', 'existing', 'not_ready', 'assembly_failed', 'failed', 'begin_failed']) {
  let held = true;
  let active = false;
  let releases = 0;
  let rollbacks = 0;
  const logStates = [];
  const failure = new Error('simulated package failure');
  const connection = {
    async beginTransaction() {
      if (scenario === 'begin_failed') throw failure;
      active = true;
    },
    async commit() { active = false; },
    async rollback() { active = false; rollbacks += 1; },
    release() { assert.equal(active, false); assert.equal(held, true); held = false; releases += 1; },
  };
  const logger = async () => {
    logStates.push(held);
    throw new Error('Auxiliary logging unavailable');
  };
  const runtime = {
    getConnection: async () => connection,
    findOrderByIdForUpdate: async () => ({ id: 1, shopify_order_id: '9001' }),
    listOrderLineItemsByOrderId: async () => [],
    findOrderFactoryPackageByOrderId: async () =>
      scenario === 'existing' ? { id: 2, artifact_id: 3 } : null,
    findArtifactById: async () => ({ id: 3 }),
    listJobsByOrderId: async () => [],
    listArtifactsByOrderId: async () => [],
    inspectOrderFactoryReadiness: async () => {
      if (scenario === 'failed') throw failure;
      return { ready: scenario !== 'not_ready', positions: [], reason: 'not_ready' };
    },
    assembleOrderFactoryPackage: async () => {
      if (scenario === 'assembly_failed') throw failure;
      return { fileCount: 1 };
    },
    createArtifact: async () => ({ id: 3 }),
    createOrderFactoryPackage: async () => ({ id: 2 }),
    ensureOrderFactoryUploadTask: async () => ({ task: { id: 4 }, created: true }),
    logInfo: logger, logWarning: logger,
  };
  const operation = ensureOrderFactoryPackage({ orderId: 1, runtime });
  if (['failed', 'begin_failed'].includes(scenario)) {
    await assert.rejects(operation, (error) => error === failure);
  } else {
    assert.equal((await operation).disposition,
      ['not_ready', 'assembly_failed'].includes(scenario) ? 'not_ready' : 'ready');
    assert.deepEqual(logStates, [false]);
  }
  assert.equal(releases, 1);
  assert.equal(rollbacks, scenario === 'failed' ? 1 : 0);
}

// Claim metadata is read while the claim's row lock is still held.
{
  const original = { getConnection: pool.getConnection, execute: pool.execute };
  const events = [];
  pool.execute = async () => assert.fail('Claim read escaped its transaction');
  pool.getConnection = async () => ({
    async beginTransaction() { events.push('begin'); },
    async execute(sql) {
      events.push(sql.startsWith('UPDATE') ? 'claim' : 'read');
      return sql.startsWith('UPDATE') ? [{ affectedRows: 1 }] : [[{
        id: 1, status: 'processing', locked_by: 'worker-a', attempt_count: 2,
      }]];
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  });
  try {
    const job = await claimPendingJobById(1, { workerId: 'worker-a', maxAttempts: 3 });
    assert.equal(job.attempt_count, 2);
    assert.deepEqual(events, ['begin', 'claim', 'read', 'commit', 'release']);
  } finally { Object.assign(pool, original); }
}

function renderDb() {
  const state = {
    job: { id: 1, order_id: 10, status: 'processing', locked_by: 'worker-b', attempt_count: 2 },
    artifacts: [], failCompletion: false, releases: 0,
  };
  let snapshot;
  function owns(params) {
    const [id, status, worker, attempt] = params.slice(-4);
    return state.job.id === id && state.job.status === status &&
      state.job.locked_by === worker && state.job.attempt_count === attempt;
  }
  const connection = {
    async beginTransaction() { snapshot = structuredClone(state); },
    async commit() { snapshot = null; },
    async rollback() {
      state.job = snapshot.job; state.artifacts = snapshot.artifacts; snapshot = null;
    },
    release() { state.releases += 1; },
    async execute(sql, params) {
      if (sql.includes('FROM jobs') && sql.includes('FOR UPDATE')) {
        return [[...(owns(params) ? [{ ...state.job }] : [])]];
      }
      if (sql.startsWith('UPDATE jobs')) {
        assert.match(sql, /WHERE id = \? AND status = \? AND locked_by = \? AND attempt_count = \?/);
        if (!owns(params)) return [{ affectedRows: 0 }];
        if (state.failCompletion) throw new Error('crash_after_artifact_insert');
        state.job.status = params[0];
        state.job.locked_by = null;
        if (sql.includes('artifact_manifest_path =')) state.job.artifact_manifest_path = params[1];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM jobs')) return [[{ ...state.job }]];
      if (sql.includes('INSERT INTO artifacts')) {
        const artifact = { id: state.artifacts.length + 1, job_id: params[1], manifest_path: params[5] };
        state.artifacts.push(artifact);
        return [{ insertId: artifact.id }];
      }
      if (sql.includes('FROM artifacts')) return [[state.artifacts.find((row) => row.id === params[0])]];
      throw new Error('Unexpected render SQL: ' + sql);
    },
  };
  return { state, db: { getConnection: async () => connection, execute: connection.execute } };
}

const stale = { id: 1, order_id: 10, locked_by: 'worker-a', attempt_count: 1 };
const output = { orderId: 10, type: 'zip', manifestPath: '/local/attempt-2/manifest.json' };
for (const sameWorker of [false, true]) {
  const { state, db } = renderDb();
  if (sameWorker) state.job.locked_by = stale.locked_by;
  for (const mutation of [
    () => markJobCompletedWithArtifactManifest(1, output.manifestPath, stale, db),
    () => markJobFailed(1, 'old failure', stale, db),
    () => markJobPendingForRetry(1, 'old retry', stale, db),
    () => publishCompletedJobArtifact(stale, output, db),
  ]) {
    await assert.rejects(mutation, { code: 'JOB_CLAIM_LOST' });
    assert.equal(state.job.status, 'processing');
    assert.equal(state.job.attempt_count, 2);
    assert.equal(state.artifacts.length, 0);
  }
}
const { state, db } = renderDb();
const owned = { ...state.job };
state.failCompletion = true;
await assert.rejects(publishCompletedJobArtifact(owned, output, db), /crash_after_artifact_insert/);
assert.equal(state.artifacts.length, 0);
assert.equal(state.job.status, 'processing');
state.failCompletion = false;
// Keep prior evidence; authority belongs only to the completed output manifest.
state.artifacts.push({ id: 1, job_id: 1, manifest_path: '/local/old-attempt/manifest.json' });
const artifact = await publishCompletedJobArtifact(owned, output, db);
assert.equal(state.job.status, 'completed');
assert.equal(state.job.artifact_manifest_path, output.manifestPath);
assert.equal(state.artifacts.length, 2);
assert.deepEqual(state.artifacts.filter((row) =>
  row.manifest_path === state.job.artifact_manifest_path), [artifact]);
await assert.rejects(publishCompletedJobArtifact(owned, output, db), { code: 'JOB_CLAIM_LOST' });
assert.equal(state.artifacts.length, 2);
for (const mutation of [markJobFailed, markJobPendingForRetry]) {
  const current = renderDb();
  await mutation(1, 'current failure', { ...current.state.job }, current.db);
  assert.equal(current.state.job.status, mutation === markJobFailed ? 'failed' : 'pending');
}
console.log('reliability transaction and render fencing smoke ok');

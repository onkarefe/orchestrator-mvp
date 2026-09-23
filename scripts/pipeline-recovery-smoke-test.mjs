import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { releaseStaleProcessingJobs } from '../src/models/JobModel.js';
import {
  listOrdersMissingFactoryPackage,
  listOrdersWithPackageMissingFactoryTask,
} from '../src/models/PipelineRecoveryModel.js';
import {
  recoverShopifyWebhooks,
  reconcileFactoryOrders,
  runPipelineRecovery,
} from '../src/services/PipelineRecoveryService.js';

const now = Date.now();
const jobs = [
  {
    id: 1,
    status: 'processing',
    attempt_count: 1,
    max_attempts: 3,
    locked_at: new Date(now - 31 * 60 * 1000),
    locked_by: 'crashed-worker',
  },
  {
    id: 2,
    status: 'processing',
    attempt_count: 3,
    max_attempts: 3,
    locked_at: new Date(now - 31 * 60 * 1000),
    locked_by: 'crashed-worker',
  },
  {
    id: 3,
    status: 'processing',
    attempt_count: 1,
    max_attempts: 3,
    locked_at: new Date(now - 5 * 60 * 1000),
    locked_by: 'active-worker',
  },
];

const staleDb = {
  async execute(sql, params) {
    const staleMinutes = params[3];
    const fallbackMaxAttempts = params[4];
    const staleBefore = now - staleMinutes * 60 * 1000;
    let affectedRows = 0;

    for (const job of jobs) {
      const maxAttempts = job.max_attempts ?? fallbackMaxAttempts;
      const stale =
        job.status === 'processing' &&
        job.locked_at &&
        job.locked_at.getTime() < staleBefore;

      if (
        sql.includes('COALESCE(attempt_count, 0) <') &&
        stale &&
        job.attempt_count < maxAttempts
      ) {
        job.status = 'pending';
        job.last_error = params[1];
        job.locked_at = null;
        job.locked_by = null;
        affectedRows += 1;
      } else if (
        sql.includes('COALESCE(attempt_count, 0) >=') &&
        stale &&
        job.attempt_count >= maxAttempts
      ) {
        job.status = 'failed';
        job.last_error = params[1];
        job.locked_at = null;
        job.locked_by = null;
        affectedRows += 1;
      }
    }

    return [{ affectedRows }];
  },
};

const staleResult = await releaseStaleProcessingJobs({
  staleLockMinutes: 30,
  maxAttempts: 3,
  db: staleDb,
});
assert.deepEqual(staleResult, { requeued: 1, failed: 1 });
assert.equal(jobs[0].status, 'pending');
assert.equal(jobs[0].last_error, 'stale_lock_released');
assert.equal(jobs[1].status, 'failed');
assert.equal(
  jobs[1].last_error,
  'stale_processing_lock_max_attempts_exceeded'
);
assert.equal(jobs[2].status, 'processing');
assert.equal(jobs[2].locked_by, 'active-worker');

let missingPackageSql = null;
let missingPackageParams = null;
await listOrdersMissingFactoryPackage({
  limit: 10,
  db: {
    async query(sql, params) {
      missingPackageSql = sql;
      missingPackageParams = params;
      return [[]];
    },
  },
});
assert.match(missingPackageSql, /NOT EXISTS \(\s*SELECT 1 FROM order_factory_packages/);
assert.match(missingPackageSql, /li\.classification NOT IN \(\?, \?\)/);
assert.match(missingPackageSql, /li\.routing_state <> \?/);
assert.match(missingPackageSql, /j\.status <> \?/);
assert.match(missingPackageSql, /a\.validation_status = 'passed'/);
assert.deepEqual(missingPackageParams, [
  'manual_review',
  'WALLPAPER',
  'ACCESSORY',
  'production_ready',
  'WALLPAPER',
  'WALLPAPER',
  'completed',
  10,
]);

assert.match(missingPackageSql, /li\.order_id = o\.id AND li\.classification = \?/);
assert.match(missingPackageSql, /CASE WHEN li\.classification = \? THEN 1 ELSE 0 END/);
assert.match(missingPackageSql, /j\.shopify_line_item_id = li\.shopify_line_item_id/);
assert.match(missingPackageSql, /j\.sku = li\.sku/);
assert.match(missingPackageSql, /o\.status <> \?/);
let missingTaskSql = null;
await listOrdersWithPackageMissingFactoryTask({
  limit: 10,
  db: {
    async query(sql) {
      missingTaskSql = sql;
      return [[]];
    },
  },
});
assert.match(missingTaskSql, /LEFT JOIN factory_upload_tasks/);
assert.match(missingTaskSql, /t\.id IS NULL/);
assert.match(missingTaskSql, /a\.validation_status = 'passed'/);

function reconciliationHarness() {
  const orders = new Map([
    [101, { kind: 'valid', package: false, task: false }],
    [102, { kind: 'valid', package: true, task: false }],
    [103, { kind: 'ACCESSORY', package: false, task: false }],
    [104, { kind: 'UNKNOWN', package: false, task: false }],
    [105, { kind: 'blocked', package: false, task: false }],
  ]);
  const counts = { packages: 0, tasks: 0 };
  const logs = [];
  let lockTail = Promise.resolve();

  async function ensureOrderFactoryPackage({ orderId }) {
    let unlock;
    const prior = lockTail;
    lockTail = new Promise((resolve) => {
      unlock = resolve;
    });
    await prior;

    try {
      const order = orders.get(orderId);

      if (!['valid', 'ACCESSORY'].includes(order.kind)) {
        return {
          disposition: 'not_ready',
          reason:
            order.kind === 'blocked'
              ? 'order_contains_blocked_line_item'
              : `order_contains_${order.kind.toLowerCase()}_line_item`,
          orderPackage: null,
          task: null,
        };
      }

      let packageCreated = false;
      let taskCreated = false;

      if (!order.package) {
        order.package = true;
        packageCreated = true;
        counts.packages += 1;
      }

      if (!order.task) {
        order.task = true;
        taskCreated = true;
        counts.tasks += 1;
      }

      return {
        disposition: 'ready',
        created: packageCreated,
        taskCreated,
        orderPackage: { id: orderId + 1000 },
        artifact: { id: orderId + 2000 },
        task: { id: orderId + 3000 },
      };
    } finally {
      unlock();
    }
  }

  const runtime = {
    listOrdersMissingFactoryPackage: async () => [101, 103, 104, 105],
    listOrdersWithPackageMissingFactoryTask: async () => [102],
    ensureOrderFactoryPackage,
    logInfo: async (entry) => logs.push(entry),
    logWarning: async (entry) => logs.push(entry),
    logError: async (entry) => logs.push(entry),
  };

  return { orders, counts, logs, runtime };
}

const config = { WORKER_RECOVERY_BATCH_SIZE: 25 };
const firstHarness = reconciliationHarness();
const firstPass = await reconcileFactoryOrders({
  config,
  runtime: firstHarness.runtime,
});
assert.equal(firstPass.packagesReconciled, 2);
assert.equal(firstPass.tasksReconciled, 3);
assert.equal(firstPass.skipped, 2);
assert.deepEqual(firstHarness.counts, { packages: 2, tasks: 3 });
assert.equal(firstHarness.orders.get(103).package, true);
assert.equal(firstHarness.orders.get(104).package, false);
assert.equal(firstHarness.orders.get(105).package, false);

const repeatedPass = await reconcileFactoryOrders({
  config,
  runtime: firstHarness.runtime,
});
assert.equal(repeatedPass.packagesReconciled, 0);
assert.equal(repeatedPass.tasksReconciled, 0);
assert.deepEqual(firstHarness.counts, { packages: 2, tasks: 3 });

const raceHarness = reconciliationHarness();
const raceResults = await Promise.all([
  reconcileFactoryOrders({ config, runtime: raceHarness.runtime }),
  reconcileFactoryOrders({ config, runtime: raceHarness.runtime }),
]);
assert.equal(
  raceResults.reduce(
    (total, result) => total + result.packagesReconciled,
    0
  ),
  2
);
assert.equal(
  raceResults.reduce((total, result) => total + result.tasksReconciled, 0),
  3
);
assert.deepEqual(raceHarness.counts, { packages: 2, tasks: 3 });

const recoveryLogs = [];
const recoveryResult = await runPipelineRecovery({
  config: {
    ...config,
    SHOPIFY_WEBHOOK_MAX_ATTEMPTS: 3,
    SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES: 30,
  },
  runtime: {
    releaseStaleProcessingJobs: async () => ({ requeued: 1, failed: 0 }),
    recoverShopifyWebhooks: async () => ({
      candidates: 0,
      recovered: 0,
      duplicates: 0,
      skipped: 0,
      failed: 0,
      exhausted: 0,
    }),
    reconcileFactoryOrders: async () => ({
      candidates: 0,
      packagesReconciled: 0,
      tasksReconciled: 0,
      skipped: 0,
      failed: 0,
    }),
    logInfo: async (entry) => recoveryLogs.push(entry),
  },
});
assert.equal(recoveryResult.staleJobs.requeued, 1);
assert.equal(recoveryLogs[0].step, 'recovery.stale_jobs_released');

{
  const recoverableIds = [201, 202];
  const claims = [];
  const processed = [];
  const failed = [];
  const webhookRecovery = await recoverShopifyWebhooks({
    config: {
      WORKER_RECOVERY_BATCH_SIZE: 25,
      SHOPIFY_WEBHOOK_MAX_ATTEMPTS: 3,
      SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES: 30,
    },
    runtime: {
      webhookWorkerId: 'recovery-worker',
      markExhaustedStaleWebhooksFailed: async (options) => {
        assert.equal(options.maxAttempts, 3);
        assert.equal(options.staleLockMinutes, 30);
        return 1;
      },
      listRecoverableWebhookIds: async (options) => {
        assert.equal(options.limit, 25);
        return recoverableIds;
      },
      claimWebhookProcessing: async (id, options) => {
        claims.push({ id, options });
        return {
          id,
          processing_status: 'processing',
          locked_by: options.workerId,
        };
      },
      processWebhookOrder: async (id, options) => {
        processed.push({ id, options });
        return {
          duplicate: id === 202,
          order: { id: id + 1000 },
        };
      },
      markWebhookFailed: async (...args) => failed.push(args),
      logInfo: async () => null,
      logError: async () => null,
    },
  });

  assert.deepEqual(webhookRecovery, {
    candidates: 2,
    recovered: 2,
    duplicates: 1,
    skipped: 0,
    failed: 0,
    exhausted: 1,
  });
  assert.equal(claims.length, 2);
  assert.equal(processed.length, 2);
  assert.equal(failed.length, 0);
}

{
  let failureDispositionCount = 0;
  const webhookRecovery = await recoverShopifyWebhooks({
    config: {
      WORKER_RECOVERY_BATCH_SIZE: 25,
      SHOPIFY_WEBHOOK_MAX_ATTEMPTS: 3,
      SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES: 30,
    },
    runtime: {
      webhookWorkerId: 'recovery-worker',
      markExhaustedStaleWebhooksFailed: async () => 0,
      listRecoverableWebhookIds: async () => [203],
      claimWebhookProcessing: async () => ({
        id: 203,
        processing_status: 'processing',
        locked_by: 'recovery-worker',
      }),
      processWebhookOrder: async () => {
        throw new Error('simulated recovery failure');
      },
      markWebhookFailed: async () => {
        failureDispositionCount += 1;
      },
      logInfo: async () => null,
      logError: async () => null,
    },
  });
  assert.equal(webhookRecovery.failed, 1);
  assert.equal(failureDispositionCount, 1);
}

const workerSource = await fs.readFile(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);
assert.match(workerSource, /await runRecoveryCycle\('startup'\)/);
assert.match(workerSource, /Date\.now\(\) >= nextRecoveryAt/);
assert.match(workerSource, /if \(isStopping \|\| isRecoveryRunning\)/);
assert.match(workerSource, /recovery\.pipeline_failed/);
assert.match(workerSource, /result\.webhooks\.recovered/);

console.log('pipeline recovery safety smoke ok');

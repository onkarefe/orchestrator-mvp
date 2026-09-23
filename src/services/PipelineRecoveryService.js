import env from '../config/env.js';
import { listRecoverableNexoCallbackIds } from '../models/FactoryCallbackModel.js';
import { replayNexoCallback } from './NexoCallbackService.js';
import {
  listOrdersMissingFactoryPackage,
  listOrdersWithPackageMissingFactoryTask,
} from '../models/PipelineRecoveryModel.js';
import {
  listRecoverableWebhookIds,
  markExhaustedStaleWebhooksFailed,
} from '../models/WebhookModel.js';
import { ensureOrderFactoryPackage } from './OrderFactoryPackageService.js';
import { releaseStaleProcessingJobs } from './JobProcessingService.js';
import { logError, logInfo, logWarning } from './LogService.js';
import { safeErrorForLog } from '../utils/redact.js';
import {
  claimWebhookProcessing,
  getWebhookWorkerId,
  markWebhookFailed,
  processWebhookOrder,
} from './WebhookService.js';

function uniqueOrderIds(...groups) {
  return [
    ...new Set(
      groups
        .flat()
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    ),
  ];
}

export async function recoverShopifyWebhooks({
  config = env,
  runtime = {},
} = {}) {
  const listCandidates =
    runtime.listRecoverableWebhookIds ?? listRecoverableWebhookIds;
  const markExhausted =
    runtime.markExhaustedStaleWebhooksFailed ??
    markExhaustedStaleWebhooksFailed;
  const claimWebhook =
    runtime.claimWebhookProcessing ?? claimWebhookProcessing;
  const processClaimedWebhook =
    runtime.processWebhookOrder ?? processWebhookOrder;
  const failClaimedWebhook =
    runtime.markWebhookFailed ?? markWebhookFailed;
  const writeInfoLog = runtime.logInfo ?? logInfo;
  const writeErrorLog = runtime.logError ?? logError;
  const workerId =
    runtime.webhookWorkerId ?? getWebhookWorkerId('webhook-recovery');
  const claimOptions = {
    workerId,
    maxAttempts: config.SHOPIFY_WEBHOOK_MAX_ATTEMPTS,
    staleLockMinutes: config.SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES,
  };
  const exhausted = await markExhausted({
    maxAttempts: claimOptions.maxAttempts,
    staleLockMinutes: claimOptions.staleLockMinutes,
  });
  const webhookIds = await listCandidates({
    limit: config.WORKER_RECOVERY_BATCH_SIZE,
    maxAttempts: claimOptions.maxAttempts,
    staleLockMinutes: claimOptions.staleLockMinutes,
  });
  const summary = {
    candidates: webhookIds.length,
    recovered: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    exhausted,
  };

  for (const webhookId of webhookIds) {
    let webhook;

    try {
      webhook = await claimWebhook(webhookId, claimOptions);

      if (!webhook) {
        summary.skipped += 1;
        continue;
      }

      const result = await processClaimedWebhook(webhook.id, { workerId });
      summary.recovered += 1;
      summary.duplicates += result.duplicate ? 1 : 0;

      try {
        await writeInfoLog({
          scopeType: 'system',
          step: 'recovery.shopify_webhook_recovered',
          message: 'Shopify paid webhook processing recovered',
          detailsJson: {
            webhookId: webhook.id,
            duplicate: Boolean(result.duplicate),
            orderId: result.order?.id ?? null,
          },
        });
      } catch {
        // The durable webhook disposition is authoritative; an auxiliary log
        // failure must not turn a completed recovery into a processing retry.
      }
    } catch (error) {
      summary.failed += 1;

      if (webhook) {
        try {
          await failClaimedWebhook(webhook.id, error.message, { workerId });
        } catch {
          // The error log below records the recovery failure even when the
          // claim was concurrently lost before its failure disposition.
        }
      }

      await writeErrorLog({
        scopeType: 'system',
        step: 'recovery.shopify_webhook_failed',
        message: 'Shopify paid webhook recovery failed safely',
        detailsJson: {
          webhookId,
          error: safeErrorForLog(error),
        },
      });
    }
  }

  return summary;
}

export async function reconcileFactoryOrders({
  config = env,
  runtime = {},
} = {}) {
  const listMissingPackages =
    runtime.listOrdersMissingFactoryPackage ??
    listOrdersMissingFactoryPackage;
  const listMissingTasks =
    runtime.listOrdersWithPackageMissingFactoryTask ??
    listOrdersWithPackageMissingFactoryTask;
  const ensurePackage =
    runtime.ensureOrderFactoryPackage ?? ensureOrderFactoryPackage;
  const writeInfoLog = runtime.logInfo ?? logInfo;
  const writeWarningLog = runtime.logWarning ?? logWarning;
  const writeErrorLog = runtime.logError ?? logError;
  const limit = config.WORKER_RECOVERY_BATCH_SIZE;
  const [missingPackageOrderIds, missingTaskOrderIds] = await Promise.all([
    listMissingPackages({ limit }),
    listMissingTasks({ limit }),
  ]);
  const packageCandidateIds = new Set(missingPackageOrderIds.map(Number));
  const taskCandidateIds = new Set(missingTaskOrderIds.map(Number));
  const orderIds = uniqueOrderIds(
    missingPackageOrderIds,
    missingTaskOrderIds
  );
  const summary = {
    candidates: orderIds.length,
    packagesReconciled: 0,
    tasksReconciled: 0,
    skipped: 0,
    failed: 0,
  };

  for (const orderId of orderIds) {
    try {
      const result = await ensurePackage({
        orderId,
        config,
      });

      if (result.disposition !== 'ready' || !result.orderPackage || !result.task) {
        summary.skipped += 1;
        await writeWarningLog({
          scopeType: 'order',
          orderId,
          step: 'recovery.factory_reconciliation_skipped',
          message: 'Factory reconciliation candidate remains blocked',
          detailsJson: {
            reason: result.reason ?? 'factory_reconciliation_not_ready',
            packageCandidate: packageCandidateIds.has(orderId),
            taskCandidate: taskCandidateIds.has(orderId),
          },
        });
        continue;
      }

      if (result.created) {
        summary.packagesReconciled += 1;
        summary.tasksReconciled += result.taskCreated ? 1 : 0;
        await writeInfoLog({
          scopeType: 'order',
          orderId,
          step: 'recovery.order_factory_package_reconciled',
          message: 'Missing order factory package reconciled',
          detailsJson: {
            packageId: result.orderPackage.id,
            artifactId: result.artifact?.id ?? null,
            taskId: result.task.id,
            taskCreated: Boolean(result.taskCreated),
          },
        });
        continue;
      }

      if (result.taskCreated) {
        summary.tasksReconciled += 1;
        await writeInfoLog({
          scopeType: 'order',
          orderId,
          step: 'recovery.factory_upload_task_reconciled',
          message: 'Missing order-level factory upload task reconciled',
          detailsJson: {
            packageId: result.orderPackage.id,
            artifactId: result.artifact?.id ?? null,
            taskId: result.task.id,
          },
        });
        continue;
      }

      summary.skipped += 1;
      await writeInfoLog({
        scopeType: 'order',
        orderId,
        step: 'recovery.factory_reconciliation_already_complete',
        message: 'Factory reconciliation candidate was already repaired',
        detailsJson: {
          packageId: result.orderPackage.id,
          taskId: result.task.id,
        },
      });
    } catch (error) {
      summary.failed += 1;
      await writeErrorLog({
        scopeType: 'order',
        orderId,
        step: 'recovery.factory_reconciliation_failed',
        message: 'Factory reconciliation failed and will retry later',
        detailsJson: {
          error: safeErrorForLog(error),
          packageCandidate: packageCandidateIds.has(orderId),
          taskCandidate: taskCandidateIds.has(orderId),
        },
      });
    }
  }

  return summary;
}

export async function recoverNexoCallbacks({ config = env, runtime = {} } = {}) {
  const listCandidates = runtime.listRecoverableNexoCallbackIds ?? listRecoverableNexoCallbackIds;
  const replay = runtime.replayNexoCallback ?? replayNexoCallback;
  const ids = await listCandidates({ limit: config.WORKER_RECOVERY_BATCH_SIZE });
  const summary = { candidates: ids.length, recovered: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    try {
      const result = await replay(id);
      if (result.body?.processingStatus === 'processed' || result.body?.duplicate) {
        summary.recovered += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      await (runtime.logError ?? logError)({
        scopeType: 'system', step: 'recovery.nexo_callback_failed',
        message: 'NEXO callback recovery failed safely',
        detailsJson: { callbackId: id, error: safeErrorForLog(error) },
      });
    }
  }
  return summary;
}

export async function runPipelineRecovery({
  config = env,
  runtime = {},
} = {}) {
  const releaseStaleJobs =
    runtime.releaseStaleProcessingJobs ?? releaseStaleProcessingJobs;
  const reconcileOrders =
    runtime.reconcileFactoryOrders ?? reconcileFactoryOrders;
  const writeInfoLog = runtime.logInfo ?? logInfo;
  const staleJobs = await releaseStaleJobs();
  const recoverWebhooks =
    runtime.recoverShopifyWebhooks ?? recoverShopifyWebhooks;

  if (staleJobs.requeued > 0 || staleJobs.failed > 0) {
    await writeInfoLog({
      scopeType: 'system',
      step: 'recovery.stale_jobs_released',
      message: 'Stale processing jobs recovered',
      detailsJson: {
        requeued: staleJobs.requeued,
        failedAtMaxAttempts: staleJobs.failed,
      },
    });
  }

  const webhooks = await recoverWebhooks({ config, runtime });
  const factory = await reconcileOrders({ config, runtime });

  const nexoCallbacks = await (runtime.recoverNexoCallbacks ?? recoverNexoCallbacks)({
    config, runtime,
  });
  return { staleJobs, webhooks, factory, nexoCallbacks };
}

export default {
  recoverShopifyWebhooks,
  recoverNexoCallbacks,
  reconcileFactoryOrders,
  runPipelineRecovery,
};

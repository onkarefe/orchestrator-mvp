import env from '../config/env.js';
import {
  listOrdersMissingFactoryPackage,
  listOrdersWithPackageMissingFactoryTask,
} from '../models/PipelineRecoveryModel.js';
import { ensureOrderFactoryPackage } from './OrderFactoryPackageService.js';
import { releaseStaleProcessingJobs } from './JobProcessingService.js';
import { logError, logInfo, logWarning } from './LogService.js';
import { safeErrorForLog } from '../utils/redact.js';

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

  const factory = await reconcileOrders({ config, runtime });

  return { staleJobs, factory };
}

export default {
  reconcileFactoryOrders,
  runPipelineRecovery,
};

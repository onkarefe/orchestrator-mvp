import os from 'node:os';

import { createArtifact } from '../models/ArtifactModel.js';
import env from '../config/env.js';
import { JOB_STATUSES, ORDER_STATUSES } from '../constants/statuses.js';
import {
  claimNextPendingJob,
  claimPendingJobById,
  findJobById,
  listJobs,
  markJobCompletedWithArtifactManifest,
  markJobFailed,
  markJobPendingForRetry,
  releaseStaleProcessingJobs as releaseStaleProcessingJobsInModel,
} from '../models/JobModel.js';
import { findOrderById, updateOrderStatus } from '../models/OrderModel.js';
import { findOrderLineItemByIdentity } from '../models/OrderLineItemModel.js';
import { processJobToZip } from '../processing/Processor.js';
import { checkProcessingDiskSpace } from './DiskGuardService.js';
import { processFactoryUploadTaskById } from './FactoryUploadService.js';
import { ensureOrderFactoryPackage } from './OrderFactoryPackageService.js';
import { logError, logInfo } from './LogService.js';
import { safeErrorForLog } from '../utils/redact.js';

const MAX_WORKER_ID_LENGTH = 191;
const ORDER_STATUS_QUEUED = 'queued';

function terminalResult(job, reason) {
  return {
    jobId: job.id,
    orderId: job.order_id,
    status: job.status,
    skipped: true,
    reason,
  };
}

function diskGuardResult(job, order, diskSpace) {
  return {
    jobId: job.id,
    orderId: order.id,
    status: JOB_STATUSES.FAILED,
    skipped: true,
    reason: diskSpace.reason,
    diskSpace,
  };
}

function failureResult(job, order, errorMessage, disposition) {
  return {
    jobId: job.id,
    orderId: order?.id ?? job.order_id,
    status: disposition.status,
    failed: true,
    retryable: !disposition.final,
    reason: errorMessage,
    attemptCount: disposition.attemptCount,
    maxAttempts: disposition.maxAttempts,
  };
}

export function getWorkerId() {
  const envWorkerId = String(process.env.WORKER_ID ?? '').trim();
  const workerId = envWorkerId || `${os.hostname()}-${process.pid}`;

  return workerId.slice(0, MAX_WORKER_ID_LENGTH);
}

export function getJobMaxAttempts(job, fallbackMaxAttempts = env.PROCESSING_MAX_ATTEMPTS) {
  const parsedJobMaxAttempts = Number.parseInt(job?.max_attempts, 10);
  const parsedFallbackMaxAttempts = Number.parseInt(fallbackMaxAttempts, 10);

  if (Number.isFinite(parsedJobMaxAttempts) && parsedJobMaxAttempts > 0) {
    return parsedJobMaxAttempts;
  }

  return Number.isFinite(parsedFallbackMaxAttempts) &&
    parsedFallbackMaxAttempts > 0
    ? parsedFallbackMaxAttempts
    : 1;
}

export function getJobFailureDisposition(
  job,
  fallbackMaxAttempts = env.PROCESSING_MAX_ATTEMPTS
) {
  const attemptCount = Number.parseInt(job?.attempt_count, 10);
  const safeAttemptCount =
    Number.isFinite(attemptCount) && attemptCount > 0 ? attemptCount : 0;
  const maxAttempts = getJobMaxAttempts(job, fallbackMaxAttempts);
  const final = safeAttemptCount >= maxAttempts;

  return {
    final,
    status: final ? JOB_STATUSES.FAILED : JOB_STATUSES.PENDING,
    attemptCount: safeAttemptCount,
    maxAttempts,
  };
}

export function getStaleLockDisposition(
  job,
  fallbackMaxAttempts = env.PROCESSING_MAX_ATTEMPTS
) {
  const disposition = getJobFailureDisposition(job, fallbackMaxAttempts);

  return {
    ...disposition,
    reason: disposition.final
      ? 'stale_processing_lock_max_attempts_exceeded'
      : 'stale_lock_released',
  };
}

export function determineAggregateOrderStatus(jobs = []) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return null;
  }

  const statuses = jobs.map((job) => job?.status);

  if (statuses.includes(JOB_STATUSES.MANUAL_REVIEW)) {
    return ORDER_STATUSES.MANUAL_REVIEW;
  }

  if (statuses.includes(JOB_STATUSES.FAILED)) {
    return ORDER_STATUSES.FAILED;
  }

  if (statuses.includes(JOB_STATUSES.PROCESSING)) {
    return ORDER_STATUSES.PROCESSING;
  }

  if (statuses.includes(JOB_STATUSES.PENDING)) {
    return ORDER_STATUS_QUEUED;
  }

  if (statuses.every((status) => status === JOB_STATUSES.COMPLETED)) {
    return ORDER_STATUSES.COMPLETED;
  }

  return ORDER_STATUS_QUEUED;
}

async function refreshOrderStatusFromJobs(orderId) {
  if (orderId === null || orderId === undefined || orderId === '') {
    return null;
  }

  const jobs = await listJobs({ orderId, limit: 10000, offset: 0 });
  const aggregateStatus = determineAggregateOrderStatus(jobs);

  if (!aggregateStatus) {
    return null;
  }

  return updateOrderStatus(orderId, aggregateStatus);
}

export function getJobProcessingStatusGate(job) {
  if (!job || job.status === JOB_STATUSES.PENDING) {
    return null;
  }

  return terminalResult(job, 'job_not_pending');
}

async function handleClaimedJobFailure({
  job,
  order,
  errorMessage,
  logDetails,
  logStep,
  logMessage,
}) {
  const disposition = getJobFailureDisposition(job);

  if (disposition.final) {
    await markJobFailed(job.id, errorMessage);

    if (order) {
      await updateOrderStatus(order.id, ORDER_STATUSES.FAILED);
    }
  } else {
    await markJobPendingForRetry(job.id, errorMessage);

    if (order) {
      await refreshOrderStatusFromJobs(order.id);
    }
  }

  await logError({
    scopeType: 'job',
    orderId: order?.id ?? job.order_id,
    jobId: job.id,
    step:
      logStep ??
      (disposition.final
        ? 'job.processing_failed_final'
        : 'job.processing_failed_retryable'),
    message:
      logMessage ??
      (disposition.final
        ? 'Job processing failed and reached max attempts'
        : 'Job processing failed and was queued for retry'),
    detailsJson: {
      errorMessage,
      attemptCount: disposition.attemptCount,
      maxAttempts: disposition.maxAttempts,
      ...logDetails,
    },
  });

  return disposition;
}

async function processClaimedJob(job, { workerId = getWorkerId() } = {}) {
  let order = null;

  if (job.status !== JOB_STATUSES.PROCESSING || job.locked_by !== workerId) {
    return terminalResult(job, 'job_not_claimed');
  }

  try {
    order = await findOrderById(job.order_id);

    if (!order) {
      throw new Error(`Related order not found for job: ${job.id}`);
    }

    const lineItem = await findOrderLineItemByIdentity(
      order.shopify_order_id,
      job.shopify_line_item_id,
      null
    );
    const diskSpace = await checkProcessingDiskSpace();

    if (!diskSpace.ok) {
      const failureReason = diskSpace.reason || 'disk_guard_failed';
      const disposition = await handleClaimedJobFailure({
        job,
        order,
        errorMessage: failureReason,
        logStep: 'job.disk_guard_failed',
        logMessage: 'Job processing blocked by disk guard',
        logDetails: {
          diskSpace,
        },
      });
      const result = diskGuardResult(job, order, diskSpace);

      return {
        ...result,
        status: disposition.status,
        retryable: !disposition.final,
        attemptCount: disposition.attemptCount,
        maxAttempts: disposition.maxAttempts,
      };
    }

    order = await updateOrderStatus(order.id, ORDER_STATUSES.PROCESSING);

    await logInfo({
      scopeType: 'job',
      orderId: order.id,
      jobId: job.id,
      step: 'job.processing_started',
      message: 'Job processing started',
      detailsJson: {
        attemptCount: job.attempt_count,
        maxAttempts: getJobMaxAttempts(job),
        workerId,
      },
    });

    const result = await processJobToZip({ order, job, lineItem });
    const artifact = await createArtifact({
      orderId: order.id,
      jobId: job.id,
      type: 'zip',
      fileName: result.zipFileName,
      filePath: result.zipPath,
      manifestPath: result.manifestPath,
      checksum: result.zipChecksum,
      fileCount: result.fileCount,
      totalSizeBytes: result.zipSizeBytes,
      fileSize: result.zipSizeBytes,
      status: 'available',
      validationStatus: result.validationResult?.validationStatus ?? 'pending',
    });

    await markJobCompletedWithArtifactManifest(
      job.id,
      result.manifestPath
    );
    order = await refreshOrderStatusFromJobs(order.id) ?? order;

    await logInfo({
      scopeType: 'job',
      orderId: order.id,
      jobId: job.id,
      step: 'job.processing_completed',
      message: 'Job processing completed',
      detailsJson: {
        artifactId: artifact.id,
        zipFileName: result.zipFileName,
        manifestPath: result.manifestPath,
        checksum: result.zipChecksum,
        validationStatus: result.validationResult?.validationStatus ?? null,
        workerId,
      },
    });

    let factoryUpload = null;

    try {
      const packageResult = await ensureOrderFactoryPackage({
        orderId: order.id,
      });

      factoryUpload = packageResult.task
        ? {
            ...packageResult,
            ...(await processFactoryUploadTaskById(packageResult.task.id, {
              workerId,
            })),
          }
        : packageResult;
    } catch (uploadIntegrationError) {
      factoryUpload = {
        disposition: 'integration_failed',
        reason:
          uploadIntegrationError.code ??
          'factory_upload_integration_failed',
      };

      await logError({
        scopeType: 'job',
        orderId: order.id,
        jobId: job.id,
        step: 'factory_package.integration_failed',
        message:
          'Order factory package integration failed without changing job completion',
        detailsJson: {
          artifactId: artifact.id,
          error: safeErrorForLog(uploadIntegrationError),
        },
      });
    }

    return {
      jobId: job.id,
      orderId: order.id,
      artifactId: artifact.id,
      zipPath: result.zipPath,
      zipFileName: result.zipFileName,
      manifestPath: result.manifestPath,
      checksum: result.zipChecksum,
      validationStatus: result.validationResult?.validationStatus ?? null,
      factoryUpload: factoryUpload
        ? {
            taskId: factoryUpload.task?.id ?? null,
            disposition: factoryUpload.disposition ?? null,
            reason: factoryUpload.reason ?? null,
          }
        : null,
    };
  } catch (error) {
    const errorMessage = error.message || 'job_processing_failed';
    const disposition = await handleClaimedJobFailure({
      job,
      order,
      errorMessage,
    });

    return failureResult(job, order, errorMessage, disposition);
  }
}

export async function processNextPendingJob() {
  const workerId = getWorkerId();
  const job = await claimNextPendingJob({
    workerId,
    maxAttempts: env.PROCESSING_MAX_ATTEMPTS,
  });

  if (!job) {
    return null;
  }

  return processClaimedJob(job, { workerId });
}

export async function processJobById(jobId) {
  const workerId = getWorkerId();
  const job = await claimPendingJobById(jobId, {
    workerId,
    maxAttempts: env.PROCESSING_MAX_ATTEMPTS,
  });

  if (!job) {
    const existingJob = await findJobById(jobId);

    if (!existingJob) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return terminalResult(existingJob, 'job_not_claimed');
  }

  return processClaimedJob(job, { workerId });
}

export async function releaseStaleProcessingJobs() {
  return releaseStaleProcessingJobsInModel({
    staleLockMinutes: env.PROCESSING_STALE_LOCK_MINUTES,
    maxAttempts: env.PROCESSING_MAX_ATTEMPTS,
  });
}

export default {
  processNextPendingJob,
  processJobById,
  getJobProcessingStatusGate,
  getWorkerId,
  getJobMaxAttempts,
  getJobFailureDisposition,
  getStaleLockDisposition,
  determineAggregateOrderStatus,
  releaseStaleProcessingJobs,
};

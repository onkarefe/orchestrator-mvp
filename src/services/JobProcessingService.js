import { createArtifact } from '../models/ArtifactModel.js';
import { JOB_STATUSES } from '../constants/statuses.js';
import {
  findJobById,
  incrementJobAttempt,
  listJobs,
  markJobCompletedWithArtifactManifest,
  markJobFailed,
  markJobProcessing,
} from '../models/JobModel.js';
import { findOrderById, updateOrderStatus } from '../models/OrderModel.js';
import { processJobToZip } from '../processing/Processor.js';
import { checkProcessingDiskSpace } from './DiskGuardService.js';
import { logError, logInfo } from './LogService.js';

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
    status: 'failed',
    skipped: true,
    reason: diskSpace.reason,
    diskSpace,
  };
}

export function getJobProcessingStatusGate(job) {
  if (!job || job.status === JOB_STATUSES.PENDING) {
    return null;
  }

  return terminalResult(job, 'job_not_pending');
}

export async function processNextPendingJob() {
  const jobs = await listJobs({
    status: JOB_STATUSES.PENDING,
    limit: 1,
    offset: 0,
  });

  if (jobs.length === 0) {
    return null;
  }

  return processJobById(jobs[0].id);
}

export async function processJobById(jobId) {
  let job = null;
  let order = null;

  try {
    job = await findJobById(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const statusGateResult = getJobProcessingStatusGate(job);

    if (statusGateResult) {
      return statusGateResult;
    }

    order = await findOrderById(job.order_id);

    if (!order) {
      await markJobFailed(job.id, 'Related order not found');
      throw new Error(`Related order not found for job: ${job.id}`);
    }

    const diskSpace = await checkProcessingDiskSpace();

    if (!diskSpace.ok) {
      const failureReason = diskSpace.reason || 'disk_guard_failed';

      await markJobFailed(job.id, failureReason);
      await updateOrderStatus(order.id, 'failed');

      await logError({
        scopeType: 'job',
        orderId: order.id,
        jobId: job.id,
        step: 'job.disk_guard_failed',
        message: 'Job processing blocked by disk guard',
        detailsJson: diskSpace,
      });

      return diskGuardResult(job, order, diskSpace);
    }

    job = await incrementJobAttempt(job.id);
    job = await markJobProcessing(job.id);
    order = await updateOrderStatus(order.id, 'processing');

    await logInfo({
      scopeType: 'job',
      orderId: order.id,
      jobId: job.id,
      step: 'job.processing_started',
      message: 'Job processing started',
    });

    const result = await processJobToZip({ order, job });
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
      validationStatus: 'pending',
    });

    await markJobCompletedWithArtifactManifest(job.id, result.manifestPath);
    await updateOrderStatus(order.id, 'completed');

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
      },
    });

    return {
      jobId: job.id,
      orderId: order.id,
      artifactId: artifact.id,
      zipPath: result.zipPath,
      zipFileName: result.zipFileName,
      manifestPath: result.manifestPath,
      checksum: result.zipChecksum,
    };
  } catch (error) {
    if (job) {
      await markJobFailed(job.id, error.message);
    }

    if (order) {
      await updateOrderStatus(order.id, 'failed');
    }

    await logError({
      scopeType: job ? 'job' : 'system',
      orderId: order?.id ?? job?.order_id ?? null,
      jobId: job?.id ?? null,
      step: 'job.processing_failed',
      message: 'Job processing failed',
      detailsJson: {
        errorMessage: error.message,
      },
    });

    throw error;
  }
}

export default {
  processNextPendingJob,
  processJobById,
  getJobProcessingStatusGate,
};

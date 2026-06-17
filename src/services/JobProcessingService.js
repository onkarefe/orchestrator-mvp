import fs from 'node:fs/promises';

import { createArtifact } from '../models/ArtifactModel.js';
import {
  findJobById,
  incrementJobAttempt,
  listJobs,
  markJobCompleted,
  markJobFailed,
  markJobProcessing,
} from '../models/JobModel.js';
import { findOrderById, updateOrderStatus } from '../models/OrderModel.js';
import { processJobToZip } from '../processing/Processor.js';
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

export async function processNextPendingJob() {
  const jobs = await listJobs({ status: 'pending', limit: 1, offset: 0 });

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

    if (job.status === 'completed') {
      return terminalResult(job, 'job_already_completed');
    }

    if (job.status === 'processing') {
      return terminalResult(job, 'job_already_processing');
    }

    order = await findOrderById(job.order_id);

    if (!order) {
      await markJobFailed(job.id, 'Related order not found');
      throw new Error(`Related order not found for job: ${job.id}`);
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
    const stat = await fs.stat(result.zipPath);
    const artifact = await createArtifact({
      orderId: order.id,
      jobId: job.id,
      type: 'zip',
      fileName: result.zipFileName,
      filePath: result.zipPath,
      fileSize: stat.size,
      status: 'available',
    });

    await markJobCompleted(job.id);
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
      },
    });

    return {
      jobId: job.id,
      orderId: order.id,
      artifactId: artifact.id,
      zipPath: result.zipPath,
      zipFileName: result.zipFileName,
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
};

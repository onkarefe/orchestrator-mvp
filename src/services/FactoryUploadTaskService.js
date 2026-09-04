import env from '../config/env.js';
import { normalizeFtpRemoteDir } from '../config/ftpUpload.js';
import { FACTORY_UPLOAD_TASK_STATUSES } from '../constants/statuses.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  createFactoryUploadTask,
  findFactoryUploadTaskByArtifactId,
  requeueTemporarilySuppressedFactoryUploadTask,
} from '../models/FactoryUploadTaskModel.js';
import { listOrderLineItemsByOrderId } from '../models/OrderLineItemModel.js';
import { evaluateFactoryDispatchGate } from './FactoryDispatchGateService.js';
import { logInfo, logWarning } from './LogService.js';

export const FACTORY_UPLOAD_SKIP_REASONS = Object.freeze({
  JOB_MANUAL_REVIEW: 'job_manual_review',
  JOB_FAILED: 'job_failed',
  ARTIFACT_VALIDATION_NOT_PASSED: 'artifact_validation_not_passed',
});

function getInitialDisposition({ job, artifact }) {
  if (job.status === 'manual_review') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: FACTORY_UPLOAD_SKIP_REASONS.JOB_MANUAL_REVIEW,
    };
  }

  if (job.status === 'failed') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: FACTORY_UPLOAD_SKIP_REASONS.JOB_FAILED,
    };
  }

  if (artifact.validation_status !== 'passed') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: FACTORY_UPLOAD_SKIP_REASONS.ARTIFACT_VALIDATION_NOT_PASSED,
    };
  }

  return {
    status: FACTORY_UPLOAD_TASK_STATUSES.PENDING,
    reason: null,
  };
}

function assertFactoryUploadIdentity({ order, job, artifact }) {
  const values = {
    orderId: order?.id,
    jobId: job?.id,
    artifactId: artifact?.id,
    shopifyOrderId: order?.shopify_order_id,
    factoryReference: job?.factory_reference,
  };

  for (const [field, value] of Object.entries(values)) {
    if (value === null || value === undefined || String(value).trim() === '') {
      const error = new Error(`Factory upload task requires ${field}`);
      error.code = 'factory_upload_identity_missing';
      throw error;
    }
  }

  if (
    String(job.order_id) !== String(order.id) ||
    String(artifact.order_id) !== String(order.id) ||
    String(artifact.job_id) !== String(job.id)
  ) {
    const error = new Error(
      'Factory upload task order, job, and artifact identity do not match'
    );
    error.code = 'factory_upload_identity_mismatch';
    throw error;
  }

  return values;
}

function assertExistingTaskCompatible(task, identity) {
  const compatible = Boolean(
    task &&
      String(task.order_id) === String(identity.orderId) &&
      String(task.job_id) === String(identity.jobId) &&
      String(task.artifact_id) === String(identity.artifactId) &&
      String(task.shopify_order_id) === String(identity.shopifyOrderId) &&
      task.factory_reference === identity.factoryReference &&
      task.upload_mode === 'files'
  );

  if (!compatible) {
    const error = new Error(
      'Existing factory upload task conflicts with artifact identity'
    );
    error.code = 'factory_upload_task_idempotency_conflict';
    throw error;
  }

  return task;
}

export async function ensureFactoryUploadTask({
  order,
  job,
  artifact,
  config = env,
  orderLineItems,
  runtime = {},
} = {}) {
  const listPersistedLineItems =
    runtime.listOrderLineItemsByOrderId ?? listOrderLineItemsByOrderId;
  const findTask =
    runtime.findFactoryUploadTaskByArtifactId ??
    findFactoryUploadTaskByArtifactId;
  const requeueTask =
    runtime.requeueTemporarilySuppressedFactoryUploadTask ??
    requeueTemporarilySuppressedFactoryUploadTask;
  const createTask = runtime.createFactoryUploadTask ?? createFactoryUploadTask;
  const writeInfoLog = runtime.logInfo ?? logInfo;
  const writeWarningLog = runtime.logWarning ?? logWarning;
  const identity = assertFactoryUploadIdentity({ order, job, artifact });
  const persistedLineItems = Array.isArray(orderLineItems)
    ? orderLineItems
    : await listPersistedLineItems(identity.orderId);
  const dispatchGate = evaluateFactoryDispatchGate({
    order,
    lineItems: persistedLineItems,
  });

  if (!dispatchGate.allowed) {
    await writeWarningLog({
      scopeType: 'order',
      orderId: identity.orderId,
      jobId: identity.jobId,
      step: 'factory_upload.order_line_item_gate_blocked',
      message: 'Factory upload task creation blocked by order line-item gate',
      detailsJson: {
        artifactId: identity.artifactId,
        reason: dispatchGate.reason,
      },
    });

    return {
      task: null,
      created: false,
      blocked: true,
      reason: dispatchGate.reason,
    };
  }

  const existingTask = await findTask(
    identity.artifactId
  );

  if (existingTask) {
    if (
      existingTask.status === FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED &&
      ['ftp_upload_disabled', 'order_not_allowlisted'].includes(
        existingTask.suppressed_reason
      )
    ) {
      const requeued = await requeueTask(
        existingTask.id
      );

      return {
        task: assertExistingTaskCompatible(requeued.task, identity),
        created: false,
      };
    }

    return {
      task: assertExistingTaskCompatible(existingTask, identity),
      created: false,
    };
  }

  const disposition = getInitialDisposition({
    job,
    artifact,
  });
  const taskDraft = {
    ...identity,
    status: disposition.status,
    uploadMode: 'files',
    remoteDir: normalizeFtpRemoteDir(config.FTP_REMOTE_DIR),
    uploadedFilesJson: [],
    suppressedReason: disposition.reason,
    maxAttempts: config.FTP_UPLOAD_TASK_MAX_ATTEMPTS,
  };
  let task;

  try {
    task = await createTask(taskDraft);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    task = await findTask(identity.artifactId);
    assertExistingTaskCompatible(task, identity);

    return {
      task,
      created: false,
    };
  }

  await writeInfoLog({
    scopeType: 'job',
    orderId: identity.orderId,
    jobId: identity.jobId,
    step: 'factory_upload.task_created',
    message: 'Factory upload task created',
    detailsJson: {
      taskId: task.id,
      artifactId: identity.artifactId,
      status: task.status,
      uploadMode: task.upload_mode,
    },
  });

  if (
    task.status === FACTORY_UPLOAD_TASK_STATUSES.SKIPPED
  ) {
    await writeWarningLog({
      scopeType: 'job',
      orderId: identity.orderId,
      jobId: identity.jobId,
      step: 'factory_upload.skipped',
      message: 'Factory upload skipped by artifact safety gate',
      detailsJson: {
        taskId: task.id,
        artifactId: identity.artifactId,
        reason: disposition.reason,
      },
    });
  }

  return {
    task,
    created: true,
  };
}

export default {
  FACTORY_UPLOAD_SKIP_REASONS,
  ensureFactoryUploadTask,
};

import path from 'node:path';

import env from '../config/env.js';
import { normalizeFtpRemoteDir } from '../config/ftpUpload.js';
import { FACTORY_UPLOAD_TASK_STATUSES } from '../constants/statuses.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  createFactoryUploadTask,
  findFactoryUploadTaskByOrderPackageId,
} from '../models/FactoryUploadTaskModel.js';
import { evaluateFactoryDispatchGate } from './FactoryDispatchGateService.js';

function assertOrderPackageIdentity({ order, orderPackage, artifact }) {
  const identity = {
    orderId: order?.id,
    jobId: null,
    artifactId: artifact?.id,
    orderFactoryPackageId: orderPackage?.id,
    shopifyOrderId: order?.shopify_order_id,
    factoryReference: orderPackage?.order_number,
  };

  for (const [field, value] of Object.entries(identity)) {
    if (field === 'jobId') {
      continue;
    }

    if (value === null || value === undefined || String(value).trim() === '') {
      const error = new Error(`Order factory upload task requires ${field}`);
      error.code = 'factory_upload_identity_missing';
      throw error;
    }
  }

  if (
    String(orderPackage.order_id) !== String(order.id) ||
    String(orderPackage.artifact_id) !== String(artifact.id) ||
    String(artifact.order_id) !== String(order.id) ||
    artifact.job_id !== null ||
    artifact.type !== 'factory_package' ||
    artifact.status !== 'available' ||
    path.resolve(String(orderPackage.manifest_path ?? '')) !==
      path.resolve(String(artifact.manifest_path ?? '')) ||
    orderPackage.xml_file_name !== artifact.file_name
  ) {
    const error = new Error(
      'Order factory package, artifact, and order identity do not match'
    );
    error.code = 'factory_upload_identity_mismatch';
    throw error;
  }

  return identity;
}

function assertExistingTaskCompatible(task, identity) {
  const compatible = Boolean(
    task &&
      String(task.order_id) === String(identity.orderId) &&
      task.job_id === null &&
      String(task.artifact_id) === String(identity.artifactId) &&
      String(task.order_factory_package_id) ===
        String(identity.orderFactoryPackageId) &&
      String(task.shopify_order_id) === String(identity.shopifyOrderId) &&
      task.factory_reference === identity.factoryReference &&
      task.upload_mode === 'files'
  );

  if (!compatible) {
    const error = new Error(
      'Existing order factory upload task conflicts with package identity'
    );
    error.code = 'factory_upload_task_idempotency_conflict';
    throw error;
  }

  return task;
}

export async function ensureOrderFactoryUploadTask({
  order,
  orderPackage,
  artifact,
  orderLineItems,
  config = env,
  db,
  runtime = {},
} = {}) {
  const findTask =
    runtime.findFactoryUploadTaskByOrderPackageId ??
    findFactoryUploadTaskByOrderPackageId;
  const createTask = runtime.createFactoryUploadTask ?? createFactoryUploadTask;
  const identity = assertOrderPackageIdentity({ order, orderPackage, artifact });
  const dispatchGate = evaluateFactoryDispatchGate({
    order,
    lineItems: orderLineItems,
  });

  if (!dispatchGate.allowed) {
    return {
      task: null,
      created: false,
      blocked: true,
      reason: dispatchGate.reason,
    };
  }

  if (orderPackage.status !== 'ready') {
    return {
      task: null,
      created: false,
      blocked: true,
      reason: 'order_factory_package_not_ready',
    };
  }

  if (artifact.validation_status !== 'passed') {
    return {
      task: null,
      created: false,
      blocked: true,
      reason: 'artifact_validation_not_passed',
    };
  }

  const existingTask = await findTask(identity.orderFactoryPackageId, db);

  if (existingTask) {
    return {
      task: assertExistingTaskCompatible(existingTask, identity),
      created: false,
    };
  }

  const taskDraft = {
    ...identity,
    status: FACTORY_UPLOAD_TASK_STATUSES.PENDING,
    uploadMode: 'files',
    remoteDir: normalizeFtpRemoteDir(config.FTP_REMOTE_DIR),
    uploadedFilesJson: [],
    suppressedReason: null,
    maxAttempts: config.FTP_UPLOAD_TASK_MAX_ATTEMPTS,
  };

  try {
    return {
      task: await createTask(taskDraft, db),
      created: true,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const task = await findTask(identity.orderFactoryPackageId, db);

    return {
      task: assertExistingTaskCompatible(task, identity),
      created: false,
    };
  }
}

export default {
  ensureOrderFactoryUploadTask,
};

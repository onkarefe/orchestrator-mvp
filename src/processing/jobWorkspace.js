import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { artifactsDir, tmpDir } from '../config/paths.js';

export function sanitizePathSegment(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  return normalized || fallback;
}

function createRunId() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function isPathInside(childPath, parentPath) {
  const resolvedChildPath = path.resolve(childPath);
  const resolvedParentPath = path.resolve(parentPath);
  const relativePath = path.relative(resolvedParentPath, resolvedChildPath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

export function buildJobWorkspace({
  orderId,
  jobId,
  shopifyOrderId,
  attemptCount = 0,
  runId = createRunId(),
} = {}) {
  if (jobId === null || jobId === undefined || jobId === '') {
    throw new Error('jobId is required');
  }

  if (orderId === null || orderId === undefined || orderId === '') {
    throw new Error('orderId is required');
  }

  const safeJobId = sanitizePathSegment(jobId, 'unknown-job');
  const safeOrderId = sanitizePathSegment(orderId, 'unknown-order');
  const safeShopifyOrderId = sanitizePathSegment(
    shopifyOrderId,
    `order-${safeOrderId}`
  );
  const safeAttemptCount = sanitizePathSegment(attemptCount, '0');
  const safeRunId = sanitizePathSegment(runId, createRunId());
  const workDir = path.join(
    tmpDir,
    'jobs',
    `job-${safeJobId}`,
    `attempt-${safeAttemptCount}-${safeRunId}`
  );
  const finalDir = path.join(
    artifactsDir,
    'orders',
    `order-${safeOrderId}`,
    'jobs',
    `job-${safeJobId}`
  );
  const zipFileName = `w-${safeShopifyOrderId}-job-${safeJobId}-${safeRunId}.zip`;
  const manifestFileName = `manifest-${safeRunId}.json`;
  const workspace = {
    jobId: safeJobId,
    orderId: safeOrderId,
    runId: safeRunId,
    workDir,
    panelsDir: path.join(workDir, 'panels'),
    packageDir: path.join(workDir, 'package'),
    finalDir,
    factoryFilesDir: path.join(finalDir, 'factory-files', safeRunId),
    workZipPath: path.join(workDir, 'package', zipFileName),
    finalZipPath: path.join(finalDir, zipFileName),
    manifestPath: path.join(finalDir, manifestFileName),
    zipFileName,
    manifestFileName,
  };

  if (!isPathInside(workspace.workDir, tmpDir)) {
    throw new Error('Workspace path escaped tmp directory');
  }

  if (!isPathInside(workspace.finalDir, artifactsDir)) {
    throw new Error('Artifact path escaped artifacts directory');
  }

  return workspace;
}

export async function createJobWorkspace(options) {
  const workspace = buildJobWorkspace(options);

  await fs.mkdir(workspace.panelsDir, { recursive: true });
  await fs.mkdir(workspace.packageDir, { recursive: true });
  await fs.mkdir(workspace.finalDir, { recursive: true });

  return workspace;
}

export default {
  sanitizePathSegment,
  buildJobWorkspace,
  createJobWorkspace,
  isPathInside,
};

import fs from 'node:fs/promises';
import path from 'node:path';

import env from '../config/env.js';
import { artifactsDir, mastersDir, tmpDir } from '../config/paths.js';

export const DISK_GUARD_REASONS = Object.freeze({
  INSUFFICIENT_DISK_SPACE: 'insufficient_disk_space',
  DISK_STAT_UNAVAILABLE: 'disk_stat_unavailable',
});

function bytesToMb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function normalizeMinFreeMb(minFreeMb) {
  const numberValue = Number(minFreeMb);

  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : env.PROCESSING_MIN_FREE_DISK_MB;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findNearestExistingPath(targetPath) {
  let currentPath = path.resolve(targetPath);
  const rootPath = path.parse(currentPath).root;

  while (!(await pathExists(currentPath))) {
    if (currentPath === rootPath) {
      return rootPath;
    }

    currentPath = path.dirname(currentPath);
  }

  return currentPath;
}

export async function getDiskFreeSpace(targetPath) {
  const resolvedTargetPath = path.resolve(targetPath);
  const checkedPath = await findNearestExistingPath(resolvedTargetPath);

  if (typeof fs.statfs !== 'function') {
    return {
      ok: false,
      targetPath: resolvedTargetPath,
      checkedPath,
      freeBytes: null,
      freeMb: null,
      reason: DISK_GUARD_REASONS.DISK_STAT_UNAVAILABLE,
    };
  }

  let stats = null;

  try {
    stats = await fs.statfs(checkedPath);
  } catch {
    return {
      ok: false,
      targetPath: resolvedTargetPath,
      checkedPath,
      freeBytes: null,
      freeMb: null,
      reason: DISK_GUARD_REASONS.DISK_STAT_UNAVAILABLE,
    };
  }

  const freeBytes = Number(stats.bavail) * Number(stats.bsize);

  return {
    ok: true,
    targetPath: resolvedTargetPath,
    checkedPath,
    freeBytes,
    freeMb: bytesToMb(freeBytes),
    reason: null,
  };
}

export async function checkDiskSpace(
  targetPath,
  { minFreeMb = env.PROCESSING_MIN_FREE_DISK_MB } = {}
) {
  const normalizedMinFreeMb = normalizeMinFreeMb(minFreeMb);
  const result = await getDiskFreeSpace(targetPath);

  if (!result.ok) {
    return {
      ...result,
      minFreeMb: normalizedMinFreeMb,
    };
  }

  const ok = result.freeMb >= normalizedMinFreeMb;

  return {
    ...result,
    ok,
    minFreeMb: normalizedMinFreeMb,
    reason: ok ? null : DISK_GUARD_REASONS.INSUFFICIENT_DISK_SPACE,
  };
}

export async function assertSufficientDiskSpace(
  targetPath,
  { minFreeMb = env.PROCESSING_MIN_FREE_DISK_MB } = {}
) {
  const result = await checkDiskSpace(targetPath, { minFreeMb });

  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = result.reason;
    error.diskSpace = result;
    throw error;
  }

  return result;
}

export async function checkProcessingDiskSpace({
  minFreeMb = env.PROCESSING_MIN_FREE_DISK_MB,
  targetPaths = [tmpDir, artifactsDir, mastersDir],
} = {}) {
  const checks = [];

  for (const targetPath of targetPaths) {
    checks.push(await checkDiskSpace(targetPath, { minFreeMb }));
  }

  const failedCheck = checks.find((check) => !check.ok);
  const freeMbValues = checks
    .map((check) => check.freeMb)
    .filter((freeMb) => freeMb !== null && freeMb !== undefined);

  return {
    ok: !failedCheck,
    targetPath: failedCheck?.targetPath ?? targetPaths.join(', '),
    minFreeMb: normalizeMinFreeMb(minFreeMb),
    freeBytes: failedCheck?.freeBytes ?? null,
    freeMb:
      failedCheck?.freeMb ??
      (freeMbValues.length ? Math.min(...freeMbValues) : null),
    reason: failedCheck?.reason ?? null,
    checks,
  };
}

export default {
  DISK_GUARD_REASONS,
  getDiskFreeSpace,
  checkDiskSpace,
  assertSufficientDiskSpace,
  checkProcessingDiskSpace,
};

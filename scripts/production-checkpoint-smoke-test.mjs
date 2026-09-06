import assert from 'node:assert/strict';

import {
  validateFtpUploadStartupEnv,
  validateWallpaperSkuStartupEnv,
} from '../src/config/startupValidation.js';
import { processNextFactoryUploadTask } from '../src/services/FactoryUploadService.js';

assert.throws(
  () => validateWallpaperSkuStartupEnv({ WALLPAPER_SKUS: [] }),
  /WALLPAPER_SKUS/
);
assert.throws(
  () => validateWallpaperSkuStartupEnv({ WALLPAPER_SKUS: [' ', ''] }),
  /WALLPAPER_SKUS/
);
assert.equal(
  validateWallpaperSkuStartupEnv({ WALLPAPER_SKUS: ['20-140.1-3'] }),
  true
);

const ftpConfig = {
  FTP_UPLOAD_ENABLED: true,
  FTP_PROTOCOL: 'ftp',
  FTP_HOST: 'factory.example.test',
  FTP_USERNAME: 'factory-user',
  FTP_PASSWORD: 'factory-password',
  FTP_REMOTE_DIR: '/factory',
  FTP_PASSIVE: true,
  FTP_SECURE: false,
  FTP_UPLOAD_MODE: 'files',
  FTP_TEMP_SUFFIX: '.uploading',
  FTP_UPLOAD_TASK_MAX_ATTEMPTS: 3,
  PROCESSING_STALE_LOCK_MINUTES: 30,
};

assert.equal(validateFtpUploadStartupEnv(ftpConfig), true);

const callCounts = {
  requeue: 0,
  release: 0,
  claim: 0,
  process: 0,
};
const readyTask = {
  id: 701,
  shopify_order_id: '9001',
  order_factory_package_id: 501,
};
const runtime = {
  requeueTemporarilySuppressedFactoryUploadTasks: async () => {
    callCounts.requeue += 1;
  },
  releaseStaleFactoryUploadTaskClaims: async () => {
    callCounts.release += 1;
  },
  claimNextFactoryUploadTask: async (options) => {
    callCounts.claim += 1;
    assert.deepEqual(options, {
      workerId: 'checkpoint-worker',
      maxAttempts: 3,
    });
    return readyTask;
  },
  processClaimedFactoryUploadTask: async ({ task, config }) => {
    callCounts.process += 1;
    assert.equal(task, readyTask);
    assert.equal(config, ftpConfig);
    return { disposition: 'uploaded', task };
  },
};

assert.equal(
  await processNextFactoryUploadTask({
    workerId: 'checkpoint-worker',
    config: { ...ftpConfig, FTP_UPLOAD_ENABLED: false },
    runtime,
  }),
  null
);
assert.deepEqual(callCounts, { requeue: 0, release: 0, claim: 0, process: 0 });

const enabledResult = await processNextFactoryUploadTask({
  workerId: 'checkpoint-worker',
  config: ftpConfig,
  runtime,
});
assert.equal(enabledResult.disposition, 'uploaded');
assert.deepEqual(callCounts, { requeue: 1, release: 1, claim: 1, process: 1 });

console.log('production checkpoint safety smoke ok');

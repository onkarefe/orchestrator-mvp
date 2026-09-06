import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  validateFtpUploadStartupEnv,
  validateWallpaperSkuStartupEnv,
} from '../src/config/startupValidation.js';
import {
  processNextFactoryUploadTask,
  uploadFile,
} from '../src/services/FactoryUploadService.js';
import { buildOrderMonitoring } from '../src/services/OrderMonitoringService.js';
import { evaluateFactoryDispatchGate } from '../src/services/FactoryDispatchGateService.js';
import {
  readiness,
  setServiceShuttingDown,
} from '../src/routes/health.routes.js';

await import('../src/app.js');
await import('../src/controllers/admin/OrderController.js');

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

const acceptedPaidOrderGate = evaluateFactoryDispatchGate({
  order: {
    id: 1,
    shopify_order_id: '9001',
    raw_payload_json: {
      line_items: [{ id: 101 }],
      cancelled_at: '2026-09-07T12:00:00Z',
      financial_status: 'refunded',
    },
  },
  lineItems: [
    {
      order_id: 1,
      shopify_order_id: '9001',
      shopify_line_item_id: '101',
      source_position: 0,
      classification: 'WALLPAPER',
      routing_state: 'production_ready',
    },
  ],
});
assert.deepEqual(acceptedPaidOrderGate, { allowed: true, reason: null });

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

const ftpCrashRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'wandini-ftp-crash-test-')
);

try {
  const localXmlPath = path.join(ftpCrashRoot, 'WANDINI-S9001.xml');
  const expectedContent = '<order>expected</order>\n';
  await fs.writeFile(localXmlPath, expectedContent, 'utf8');
  const expectedChecksum = crypto
    .createHash('sha256')
    .update(expectedContent)
    .digest('hex');
  const ftpCalls = { download: 0, upload: 0, rename: 0, progress: 0 };
  const ftpClient = {
    fileExists: async () => true,
    downloadFile: async (fileName, destination) => {
      ftpCalls.download += 1;
      assert.equal(fileName, 'WANDINI-S9001.xml');
      await fs.copyFile(localXmlPath, destination);
    },
    uploadTemporary: async () => {
      ftpCalls.upload += 1;
    },
    renameTemporary: async () => {
      ftpCalls.rename += 1;
    },
    remotePath: (fileName) => `/factory/${fileName}`,
  };
  const reconciledProgress = await uploadFile({
    ftpClient,
    file: {
      type: 'xml',
      fileName: 'WANDINI-S9001.xml',
      filePath: localXmlPath,
      checksum: expectedChecksum,
    },
    task: { id: 701, order_id: 1, job_id: null, artifact_id: 501 },
    workerId: 'checkpoint-worker',
    progress: [],
    runtime: {
      updateFactoryUploadTaskProgress: async () => {
        ftpCalls.progress += 1;
        return true;
      },
      logInfo: async () => null,
    },
  });
  assert.equal(reconciledProgress[0].status, 'renamed');
  assert.deepEqual(ftpCalls, {
    download: 1,
    upload: 0,
    rename: 0,
    progress: 1,
  });

  ftpClient.downloadFile = async (fileName, destination) => {
    ftpCalls.download += 1;
    await fs.writeFile(destination, 'different remote content', 'utf8');
  };
  await assert.rejects(
    uploadFile({
      ftpClient,
      file: {
        type: 'xml',
        fileName: 'WANDINI-S9001.xml',
        filePath: localXmlPath,
        checksum: expectedChecksum,
      },
      task: { id: 701, order_id: 1, job_id: null, artifact_id: 501 },
      workerId: 'checkpoint-worker',
      progress: [],
      runtime: {
        updateFactoryUploadTaskProgress: async () => true,
        logInfo: async () => null,
      },
    }),
    (error) => error.code === 'remote_file_identity_mismatch'
  );
  assert.equal(ftpCalls.upload, 0);
  assert.equal(ftpCalls.rename, 0);
} finally {
  await fs.rm(ftpCrashRoot, { recursive: true, force: true });
}

const monitoring = buildOrderMonitoring({
  order: {
    id: 1,
    shopify_order_id: '9001',
    status: 'shipped',
    factory_status: 'shipped',
    raw_payload_json: { line_items: [{ id: 101 }] },
  },
  lineItems: [{ classification: 'WALLPAPER', routing_state: 'production_ready' }],
  jobs: [{ status: 'completed' }],
  orderPackage: { status: 'ready', factory_status: 'shipped' },
  uploadTask: { status: 'uploaded' },
  shopifyUpdateTasks: [{ status: 'failed', last_error: 'write failed' }],
});
assert.ok(
  monitoring.anomalies.some(
    (item) => item.code === 'shopify_fulfillment_failed'
  )
);

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

setServiceShuttingDown(false);
const readyResponse = responseRecorder();
await readiness({}, readyResponse, { db: { query: async () => [[{ ready: 1 }]] } });
assert.equal(readyResponse.statusCode, 200);
assert.equal(readyResponse.body.ok, true);
const unavailableResponse = responseRecorder();
await readiness({}, unavailableResponse, {
  db: { query: async () => { throw new Error('db unavailable'); } },
});
assert.equal(unavailableResponse.statusCode, 503);
setServiceShuttingDown(true);
const shutdownResponse = responseRecorder();
await readiness({}, shutdownResponse, { db: { query: async () => null } });
assert.equal(shutdownResponse.statusCode, 503);
setServiceShuttingDown(false);

console.log('production checkpoint safety smoke ok');

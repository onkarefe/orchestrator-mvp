import {
  getSafeStartupConfigSummary,
  validateFtpUploadStartupEnv,
  validateWallpaperSkuStartupEnv,
} from './config/startupValidation.js';
import env from './config/env.js';
import {
  getWorkerId,
  processNextPendingJob,
} from './services/JobProcessingService.js';
import { processNextFactoryUploadTask } from './services/FactoryUploadService.js';
import { runPipelineRecovery } from './services/PipelineRecoveryService.js';
import { logError } from './services/LogService.js';
import { safeErrorForLog } from './utils/redact.js';

const POLL_INTERVAL_MS = 3000;
const workerId = getWorkerId();

let isRunning = false;
let isRecoveryRunning = false;
let isStopping = false;
let timer = null;
let nextRecoveryAt = 0;

async function runRecoveryCycle(trigger) {
  if (isStopping || isRecoveryRunning) {
    return null;
  }

  isRecoveryRunning = true;

  try {
    const result = await runPipelineRecovery();

    if (
      result.staleJobs.requeued > 0 ||
      result.staleJobs.failed > 0 ||
      result.factory.packagesReconciled > 0 ||
      result.factory.tasksReconciled > 0 ||
      result.factory.failed > 0
    ) {
      console.log('Worker recovery completed:', {
        trigger,
        ...result,
      });
    }

    return result;
  } catch (error) {
    const safeError = safeErrorForLog(error);

    try {
      await logError({
        scopeType: 'system',
        step: 'recovery.pipeline_failed',
        message: 'Worker recovery pass failed and will retry later',
        detailsJson: {
          trigger,
          error: safeError,
        },
      });
    } catch (logFailure) {
      console.error(
        'Worker recovery failure audit failed:',
        safeErrorForLog(logFailure)
      );
    }

    console.error('Worker recovery error:', safeError);
    return null;
  } finally {
    nextRecoveryAt = Date.now() + env.WORKER_RECOVERY_INTERVAL_MS;
    isRecoveryRunning = false;
  }
}

async function tick() {
  if (isStopping || isRunning) {
    return;
  }

  isRunning = true;

  try {
    if (Date.now() >= nextRecoveryAt) {
      await runRecoveryCycle('periodic');
    }

    const jobResult = await processNextPendingJob();
    const factoryUploadResult = jobResult
      ? null
      : await processNextFactoryUploadTask({ workerId });
    const result = jobResult ?? factoryUploadResult;

    if (result) {
      console.log('Worker processed item:', result);
    }
  } catch (error) {
    console.error('Worker processing error:', safeErrorForLog(error));
  } finally {
    isRunning = false;
  }
}

function stop(signal) {
  isStopping = true;

  if (timer) {
    clearInterval(timer);
  }

  console.log(`Worker stopping after ${signal}`);

  if (!isRunning) {
    process.exit(0);
  }

  const waitForCurrentJob = setInterval(() => {
    if (!isRunning) {
      clearInterval(waitForCurrentJob);
      process.exit(0);
    }
  }, 100);
}

validateFtpUploadStartupEnv();
validateWallpaperSkuStartupEnv();

const startupConfig = getSafeStartupConfigSummary();

console.log(
  'Worker started:',
  JSON.stringify({
    ftpUploadEnabled: startupConfig.ftpUploadEnabled,
    ftpProtocolSupported: startupConfig.ftpProtocolSupported,
    ftpSecure: startupConfig.ftpSecure,
    ftpPassive: startupConfig.ftpPassive,
    ftpHostConfigured: startupConfig.ftpHostConfigured,
    ftpCredentialsConfigured: startupConfig.ftpCredentialsConfigured,
    ftpRemoteDirConfigured: startupConfig.ftpRemoteDirConfigured,
    ftpUploadTaskMaxAttempts: startupConfig.ftpUploadTaskMaxAttempts,
    workerRecoveryIntervalMs: env.WORKER_RECOVERY_INTERVAL_MS,
    workerRecoveryBatchSize: env.WORKER_RECOVERY_BATCH_SIZE,
  })
);

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

await runRecoveryCycle('startup');
timer = setInterval(tick, POLL_INTERVAL_MS);
await tick();

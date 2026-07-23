import {
  getSafeStartupConfigSummary,
  validateFtpUploadStartupEnv,
} from './config/startupValidation.js';
import {
  getWorkerId,
  processNextPendingJob,
} from './services/JobProcessingService.js';
import { processNextFactoryUploadTask } from './services/FactoryUploadService.js';
import { safeErrorForLog } from './utils/redact.js';

const POLL_INTERVAL_MS = 3000;
const workerId = getWorkerId();

let isRunning = false;
let isStopping = false;
let timer = null;

async function tick() {
  if (isStopping || isRunning) {
    return;
  }

  isRunning = true;

  try {
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
    ftpUploadOrderAllowlistCount:
      startupConfig.ftpUploadOrderAllowlistCount,
    ftpUploadTaskMaxAttempts: startupConfig.ftpUploadTaskMaxAttempts,
  })
);

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

timer = setInterval(tick, POLL_INTERVAL_MS);
await tick();

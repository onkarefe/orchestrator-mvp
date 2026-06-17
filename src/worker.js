import { processNextPendingJob } from './services/JobProcessingService.js';

const POLL_INTERVAL_MS = 3000;

let isRunning = false;
let isStopping = false;
let timer = null;

async function tick() {
  if (isStopping || isRunning) {
    return;
  }

  isRunning = true;

  try {
    const result = await processNextPendingJob();

    if (result) {
      console.log('Processed job:', result);
    }
  } catch (error) {
    console.error('Worker processing error:', error);
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

console.log('Worker started');

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

timer = setInterval(tick, POLL_INTERVAL_MS);
await tick();

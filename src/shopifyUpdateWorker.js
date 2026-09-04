import os from 'node:os';

import env from './config/env.js';
import {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
} from './config/startupValidation.js';
import pool from './db/connection.js';
import { createShopifyUpdateConsumer } from './services/ShopifyUpdateConsumerService.js';
import { safeErrorForLog } from './utils/redact.js';

const workerId = `shopify-update:${os.hostname()}:${process.pid}`.slice(
  0,
  191
);
let shutdownStarted = false;

validateServerStartupEnv();

console.log(
  'Shopify update consumer started:',
  JSON.stringify({
    workerId,
    pollIntervalMs: env.SHOPIFY_UPDATE_POLL_INTERVAL_MS,
    ...getSafeStartupConfigSummary(),
  })
);

const consumer = createShopifyUpdateConsumer({
  config: env,
  workerId,
});

async function shutdown(signal) {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.log(`Shopify update consumer stopping after ${signal}`);

  try {
    await consumer.stop();
    await pool.end();
  } catch (error) {
    console.error(
      'Shopify update consumer shutdown failed:',
      safeErrorForLog(error)
    );
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await consumer.start();
} catch (error) {
  console.error(
    'Shopify update consumer startup failed:',
    safeErrorForLog(error)
  );
  await pool.end();
  process.exitCode = 1;
}

import 'dotenv/config';

import app from './app.js';
import env from './config/env.js';
import pool from './db/connection.js';
import { setServiceShuttingDown } from './routes/health.routes.js';
import { safeErrorForLog } from './utils/redact.js';
import {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
} from './config/startupValidation.js';

validateServerStartupEnv();

const port = env.PORT;

console.log(
  'Startup safety config:',
  JSON.stringify(getSafeStartupConfigSummary())
);

const server = app.listen(port, () => {
  console.log(`Orchestrator MVP listening on port ${port}`);
});

const SHUTDOWN_TIMEOUT_MS = 10000;
let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  setServiceShuttingDown(true);
  console.log(`HTTP service stopping after ${signal}`);

  let timeoutId;
  const hardStop = setTimeout(() => {
    console.error('HTTP shutdown hard deadline reached');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS + 5000);
  hardStop.unref();

  try {
    const closeResult = await Promise.race([
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve('closed')));
        server.closeIdleConnections?.();
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);

    if (closeResult === 'timeout') {
      console.error('HTTP shutdown deadline reached; closing active connections');
      server.closeAllConnections?.();
    }

    await pool.end();
  } catch (error) {
    console.error('HTTP service shutdown failed:', safeErrorForLog(error));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(hardStop);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

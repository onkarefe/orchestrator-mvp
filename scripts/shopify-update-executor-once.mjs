import os from 'node:os';

import env from '../src/config/env.js';
import {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
} from '../src/config/startupValidation.js';
import pool from '../src/db/connection.js';
import { runShopifyUpdateExecutorOnce } from '../src/services/ShopifyUpdateExecutorService.js';
import { safeErrorForLog } from '../src/utils/redact.js';

const workerId = `shopify-update-once:${os.hostname()}:${process.pid}`.slice(
  0,
  191
);

try {
  validateServerStartupEnv();

  console.log(
    'Shopify update executor safety config:',
    JSON.stringify(getSafeStartupConfigSummary())
  );

  const result = await runShopifyUpdateExecutorOnce({
    config: env,
    workerId,
  });

  console.log('Shopify update executor one-shot result:', JSON.stringify(result));
} catch (error) {
  console.error(
    'Shopify update executor one-shot failed:',
    safeErrorForLog(error)
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

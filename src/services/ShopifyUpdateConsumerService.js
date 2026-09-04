import env from '../config/env.js';
import { safeErrorForLog } from '../utils/redact.js';
import { logError } from './LogService.js';
import { runShopifyUpdateExecutorOnce } from './ShopifyUpdateExecutorService.js';

export function createShopifyUpdateConsumer({
  config = env,
  workerId,
  executeOnce = runShopifyUpdateExecutorOnce,
  logErrorFn = logError,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let running = false;
  let stopping = false;
  let timer = null;
  let idleWaiters = [];

  function releaseIdleWaiters() {
    const waiters = idleWaiters;
    idleWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  }

  async function poll(trigger = 'manual') {
    if (stopping) {
      return { skipped: true, reason: 'consumer_stopping' };
    }

    if (running) {
      return { skipped: true, reason: 'poll_already_running' };
    }

    running = true;

    try {
      return await executeOnce({ config, workerId });
    } catch (error) {
      const safeError = safeErrorForLog(error);

      try {
        await logErrorFn({
          scopeType: 'system',
          step: 'shopify_update_consumer.poll_failed',
          message: 'Shopify update consumer poll failed and will retry',
          detailsJson: {
            workerId,
            trigger,
            error: safeError,
          },
        });
      } catch (logFailure) {
        console.error(
          'Shopify update consumer failure audit failed:',
          safeErrorForLog(logFailure)
        );
      }

      return {
        failed: true,
        error: safeError,
      };
    } finally {
      running = false;
      releaseIdleWaiters();
    }
  }

  async function start() {
    if (stopping) {
      throw new Error('Shopify update consumer cannot restart after stopping');
    }

    if (timer) {
      return { started: false, reason: 'consumer_already_started' };
    }

    timer = setIntervalFn(() => {
      void poll('interval');
    }, config.SHOPIFY_UPDATE_POLL_INTERVAL_MS);

    const initialResult = await poll('startup');
    return { started: true, initialResult };
  }

  async function stop() {
    stopping = true;

    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }

    if (running) {
      await new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    }
  }

  return {
    poll,
    start,
    stop,
    isRunning: () => running,
    isStopping: () => stopping,
  };
}

export default {
  createShopifyUpdateConsumer,
};

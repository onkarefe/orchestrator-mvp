import assert from 'node:assert/strict';

import { createShopifyUpdateConsumer } from '../src/services/ShopifyUpdateConsumerService.js';

let releaseFirstPoll;
const firstPoll = new Promise((resolve) => {
  releaseFirstPoll = resolve;
});
let firstCalls = 0;
let clearedTimer = null;
const firstConsumer = createShopifyUpdateConsumer({
  config: { SHOPIFY_UPDATE_POLL_INTERVAL_MS: 1000 },
  workerId: 'consumer-smoke-one',
  executeOnce: async () => {
    firstCalls += 1;
    await firstPoll;
    return { processed: 0 };
  },
  logErrorFn: async () => {},
  setIntervalFn: () => ({ id: 1 }),
  clearIntervalFn: (timer) => {
    clearedTimer = timer;
  },
});

const startPromise = firstConsumer.start();
await Promise.resolve();
assert.equal(firstConsumer.isRunning(), true);
assert.deepEqual(await firstConsumer.poll('overlap'), {
  skipped: true,
  reason: 'poll_already_running',
});
assert.equal(firstCalls, 1);

let stopped = false;
const stopPromise = firstConsumer.stop().then(() => {
  stopped = true;
});
await Promise.resolve();
assert.equal(stopped, false);
releaseFirstPoll();
await startPromise;
await stopPromise;
assert.equal(stopped, true);
assert.deepEqual(clearedTimer, { id: 1 });
assert.deepEqual(await firstConsumer.poll('after-stop'), {
  skipped: true,
  reason: 'consumer_stopping',
});

let retryCalls = 0;
const loggedErrors = [];
const retryConsumer = createShopifyUpdateConsumer({
  config: { SHOPIFY_UPDATE_POLL_INTERVAL_MS: 1000 },
  workerId: 'consumer-smoke-two',
  executeOnce: async () => {
    retryCalls += 1;

    if (retryCalls === 1) {
      throw new Error('isolated poll failure');
    }

    return { processed: 1 };
  },
  logErrorFn: async (entry) => {
    loggedErrors.push(entry);
  },
  setIntervalFn: () => ({ id: 2 }),
  clearIntervalFn: () => {},
});

const failedPoll = await retryConsumer.start();
assert.equal(failedPoll.started, true);
assert.equal(failedPoll.initialResult.failed, true);
assert.equal(loggedErrors.length, 1);
const recoveredPoll = await retryConsumer.poll('recovery');
assert.equal(recoveredPoll.processed, 1);
assert.equal(retryCalls, 2);
await retryConsumer.stop();

console.log('Shopify update consumer smoke ok');

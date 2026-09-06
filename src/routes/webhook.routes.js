import { Router, raw } from 'express';

import ShopifyWebhookController from '../controllers/webhook/ShopifyWebhookController.js';

const router = Router();

const shopifyWebhookRawBody = raw({
  type: 'application/json',
  limit: '2mb',
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  },
});

router.post(
  '/webhooks/shopify/orders-paid',
  shopifyWebhookRawBody,
  ShopifyWebhookController.recordOrdersPaidWebhook
);
router.post(
  '/webhooks/shopify/orders-cancelled',
  shopifyWebhookRawBody,
  ShopifyWebhookController.recordOrdersCancelledWebhook
);
router.post(
  '/webhooks/shopify/orders-updated',
  shopifyWebhookRawBody,
  ShopifyWebhookController.recordOrdersUpdatedWebhook
);
router.post(
  '/webhooks/shopify/refunds-create',
  shopifyWebhookRawBody,
  ShopifyWebhookController.recordRefundsCreateWebhook
);

export default router;

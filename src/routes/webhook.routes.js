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

export default router;

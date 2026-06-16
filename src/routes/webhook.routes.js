import { Router } from 'express';

import ShopifyWebhookController from '../controllers/webhook/ShopifyWebhookController.js';

const router = Router();

router.post('/webhooks/shopify/orders-paid', ShopifyWebhookController.recordOrdersPaidWebhook);

export default router;

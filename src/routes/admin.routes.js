import { Router } from 'express';

import DashboardController from '../controllers/admin/DashboardController.js';
import WebhookController from '../controllers/admin/WebhookController.js';

const router = Router();

router.get('/admin', DashboardController.index);
router.get('/admin/webhooks', WebhookController.index);
router.get('/admin/webhooks/:id', WebhookController.show);

export default router;

import { Router } from 'express';

import DashboardController from '../controllers/admin/DashboardController.js';
import JobController from '../controllers/admin/JobController.js';
import OrderController from '../controllers/admin/OrderController.js';
import WebhookController from '../controllers/admin/WebhookController.js';
import ArtifactDownloadController from '../controllers/download/ArtifactDownloadController.js';

const router = Router();

router.get('/admin', DashboardController.index);
router.get('/admin/orders', OrderController.index);
router.get('/admin/orders/:id', OrderController.show);
router.get('/admin/jobs', JobController.index);
router.get('/admin/jobs/:id', JobController.show);
router.get('/admin/artifacts/:id/download', ArtifactDownloadController.download);
router.get('/admin/webhooks', WebhookController.index);
router.get('/admin/webhooks/:id', WebhookController.show);

export default router;

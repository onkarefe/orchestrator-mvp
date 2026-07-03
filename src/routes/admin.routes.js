import { Router } from 'express';

import ArtifactController from '../controllers/admin/ArtifactController.js';
import DashboardController from '../controllers/admin/DashboardController.js';
import FactoryCallbackController from '../controllers/admin/FactoryCallbackController.js';
import JobController from '../controllers/admin/JobController.js';
import OrderController from '../controllers/admin/OrderController.js';
import ShopifyUpdateTaskController from '../controllers/admin/ShopifyUpdateTaskController.js';
import WebhookController from '../controllers/admin/WebhookController.js';
import ArtifactDownloadController from '../controllers/download/ArtifactDownloadController.js';
import requireAdminAccess from '../middleware/adminAccess.js';

const router = Router();

router.use('/admin', requireAdminAccess);

router.get('/admin', DashboardController.index);
router.get('/admin/orders', OrderController.index);
router.get('/admin/orders/:id', OrderController.show);
router.get('/admin/jobs', JobController.index);
router.get('/admin/jobs/:id', JobController.show);
router.get('/admin/artifacts', ArtifactController.index);
router.get('/admin/artifacts/:id', ArtifactController.show);
router.get('/admin/artifacts/:id/download', ArtifactDownloadController.download);
router.get('/admin/webhooks', WebhookController.index);
router.get('/admin/webhooks/:id', WebhookController.show);
router.get('/admin/factory-callbacks', FactoryCallbackController.index);
router.get('/admin/factory-callbacks/:id', FactoryCallbackController.show);
router.get('/admin/shopify-update-tasks', ShopifyUpdateTaskController.index);
router.get('/admin/shopify-update-tasks/:id', ShopifyUpdateTaskController.show);

export default router;

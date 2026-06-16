import { Router } from 'express';

import DashboardController from '../controllers/admin/DashboardController.js';

const router = Router();

router.get('/admin', DashboardController.index);

export default router;

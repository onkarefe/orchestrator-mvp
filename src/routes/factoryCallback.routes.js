import { Router, json } from 'express';

import env from '../config/env.js';
import FactoryCallbackController from '../controllers/webhook/FactoryCallbackController.js';

const router = Router();

const factoryCallbackJson = json({
  type: 'application/json',
  limit: '64kb',
});

function requireFactoryCallbackEnabled(req, res, next) {
  if (!env.FACTORY_CALLBACK_ENABLED) {
    res.status(404).json({
      ok: false,
      error: 'factory_callback_disabled',
    });
    return;
  }

  next();
}

router.post(
  '/webhooks/factory/status',
  requireFactoryCallbackEnabled,
  factoryCallbackJson,
  FactoryCallbackController.recordFactoryStatusCallback
);

router.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({
      ok: false,
      error: 'invalid_json_payload',
    });
    return;
  }

  if (error?.type === 'entity.too.large') {
    res.status(413).json({
      ok: false,
      error: 'factory_callback_payload_too_large',
    });
    return;
  }

  next(error);
});

export default router;

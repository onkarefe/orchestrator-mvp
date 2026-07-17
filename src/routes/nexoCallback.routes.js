import { Router, json } from 'express';

import env from '../config/env.js';
import NexoCallbackController from '../controllers/webhook/NexoCallbackController.js';

const router = Router();

const nexoCallbackJson = json({
  type: 'application/json',
  limit: '64kb',
  verify(req, res, buffer) {
    req.nexoRawBody = Buffer.from(buffer);
  },
});

function requireNexoCallbackEnabled(req, res, next) {
  if (!env.NEXO_CALLBACK_ENABLED) {
    res.status(404).json({
      ok: false,
      error: 'nexo_callback_disabled',
    });
    return;
  }

  next();
}

router.post(
  '/webhooks/nexo/status',
  requireNexoCallbackEnabled,
  nexoCallbackJson,
  NexoCallbackController.recordNexoStatusCallback
);

router.use(async (error, req, res, next) => {
  if (req.path !== '/webhooks/nexo/status') {
    next(error);
    return;
  }

  if (error?.type === 'entity.parse.failed') {
    await NexoCallbackController.recordNexoParserFailure(req, res, {
      errorCode: 'invalid_json_payload',
      httpStatus: 400,
    });
    return;
  }

  if (error?.type === 'entity.too.large') {
    await NexoCallbackController.recordNexoParserFailure(req, res, {
      errorCode: 'nexo_callback_payload_too_large',
      httpStatus: 413,
    });
    return;
  }

  next(error);
});

export default router;

import { receiveFactoryCallback } from '../../services/FactoryCallbackService.js';
import { safeErrorForLog } from '../../utils/redact.js';

export async function recordFactoryStatusCallback(req, res) {
  try {
    const result = await receiveFactoryCallback({
      payload: req.body,
      headers: req.headers,
    });

    res.status(result.httpStatus).json(result.body);
  } catch (error) {
    console.error('Factory callback handling failed:', safeErrorForLog(error));

    res.status(500).json({
      ok: false,
      error: 'factory_callback_handling_failed',
    });
  }
}

export default {
  recordFactoryStatusCallback,
};

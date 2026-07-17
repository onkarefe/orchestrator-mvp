import {
  receiveNexoCallback,
  recordNexoTransportFailure,
} from '../../services/NexoCallbackService.js';
import { safeErrorForLog } from '../../utils/redact.js';

export async function recordNexoStatusCallback(req, res) {
  try {
    const result = await receiveNexoCallback({
      payload: req.body,
      headers: req.headers,
    });

    res.status(result.httpStatus).json(result.body);
  } catch (error) {
    console.error('NEXO callback handling failed:', safeErrorForLog(error));

    res.status(500).json({
      ok: false,
      error: 'nexo_callback_handling_failed',
    });
  }
}

export async function recordNexoParserFailure(
  req,
  res,
  { errorCode, httpStatus }
) {
  try {
    const result = await recordNexoTransportFailure({
      rawBody: req.nexoRawBody,
      headers: req.headers,
      errorCode,
    });
    const authError = result.auth.error;
    const responseStatus = authError
      ? authError === 'nexo_callback_api_key_not_configured'
        ? 503
        : 401
      : httpStatus;

    res.status(responseStatus).json({
      ok: false,
      error: authError ?? errorCode,
      callbackId: result.callback.id,
      processingStatus: result.callback.processing_status,
    });
  } catch (error) {
    console.error(
      'NEXO callback parser failure audit failed:',
      safeErrorForLog(error)
    );

    res.status(500).json({
      ok: false,
      error: 'nexo_callback_failure_audit_failed',
    });
  }
}

export default {
  recordNexoParserFailure,
  recordNexoStatusCallback,
};

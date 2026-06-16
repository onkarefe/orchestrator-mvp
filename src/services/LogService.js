import { createLog } from '../models/LogModel.js';

export async function logEvent(data) {
  try {
    if (!data?.message) {
      throw new Error('Log message is required');
    }

    return await createLog({
      scopeType: data.scopeType ?? 'system',
      orderId: data.orderId ?? null,
      jobId: data.jobId ?? null,
      level: data.level ?? 'info',
      step: data.step ?? null,
      message: data.message,
      detailsJson: data.detailsJson ?? null,
    });
  } catch (error) {
    console.error('Logging failed:', error);
    return null;
  }
}

export function logInfo(data) {
  return logEvent({
    ...data,
    level: 'info',
  });
}

export function logWarning(data) {
  return logEvent({
    ...data,
    level: 'warning',
  });
}

export function logError(data) {
  return logEvent({
    ...data,
    level: 'error',
  });
}

export default {
  logInfo,
  logWarning,
  logError,
  logEvent,
};

export const STATUS_GROUPS = Object.freeze({
  ORDER: 'order',
  JOB: 'job',
  WEBHOOK_PROCESSING: 'webhook_processing',
  ARTIFACT: 'artifact',
  FACTORY_CALLBACK_PROCESSING: 'factory_callback_processing',
  FACTORY_UPLOAD_TASK: 'factory_upload_task',
  SHOPIFY_UPDATE_TASK: 'shopify_update_task',
});

export const ORDER_STATUSES = Object.freeze({
  SECURITY_HOLD: 'SECURITY_HOLD',
  RECEIVED: 'received',
  VALIDATED: 'validated',
  PROCESSING: 'processing',
  ARTIFACT_READY: 'artifact_ready',
  MANUAL_REVIEW: 'manual_review',
  FAILED: 'failed',
  COMPLETED: 'completed',
  FACTORY_RECEIVED: 'factory_received',
  PRODUCTION_STARTED: 'production_started',
  PRODUCTION_COMPLETED: 'production_completed',
  READY_FOR_SHIPPING: 'ready_for_shipping',
  SHIPPED: 'shipped',
});

export const JOB_STATUSES = Object.freeze({
  PENDING: 'pending',
  VALIDATING: 'validating',
  PROCESSING: 'processing',
  ARTIFACT_GENERATED: 'artifact_generated',
  MANUAL_REVIEW: 'manual_review',
  FAILED: 'failed',
  COMPLETED: 'completed',
});

export const WEBHOOK_PROCESSING_STATUSES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  DUPLICATE: 'duplicate',
  INVALID_HMAC: 'invalid_hmac',
  REJECTED: 'rejected',
  FAILED: 'failed',
});

export const ARTIFACT_STATUSES = Object.freeze({
  PENDING: 'pending',
  VALID: 'valid',
  INVALID: 'invalid',
  AVAILABLE: 'available',
  FAILED: 'failed',
});

export const FACTORY_CALLBACK_PROCESSING_STATUSES = Object.freeze({
  RECEIVED: 'received',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  DUPLICATE: 'duplicate',
  MANUAL_REVIEW: 'manual_review',
  FAILED: 'failed',
});

export const SHOPIFY_UPDATE_TASK_STATUSES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  MANUAL_REVIEW: 'manual_review',
});

export const FACTORY_UPLOAD_TASK_STATUSES = Object.freeze({
  PENDING: 'pending',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  SUPPRESSED: 'suppressed',
});

export const STATUS_VALUES_BY_GROUP = Object.freeze({
  [STATUS_GROUPS.ORDER]: Object.freeze(Object.values(ORDER_STATUSES)),
  [STATUS_GROUPS.JOB]: Object.freeze(Object.values(JOB_STATUSES)),
  [STATUS_GROUPS.WEBHOOK_PROCESSING]: Object.freeze(
    Object.values(WEBHOOK_PROCESSING_STATUSES)
  ),
  [STATUS_GROUPS.ARTIFACT]: Object.freeze(Object.values(ARTIFACT_STATUSES)),
  [STATUS_GROUPS.FACTORY_CALLBACK_PROCESSING]: Object.freeze(
    Object.values(FACTORY_CALLBACK_PROCESSING_STATUSES)
  ),
  [STATUS_GROUPS.FACTORY_UPLOAD_TASK]: Object.freeze(
    Object.values(FACTORY_UPLOAD_TASK_STATUSES)
  ),
  [STATUS_GROUPS.SHOPIFY_UPDATE_TASK]: Object.freeze(
    Object.values(SHOPIFY_UPDATE_TASK_STATUSES)
  ),
});

export default {
  STATUS_GROUPS,
  ORDER_STATUSES,
  JOB_STATUSES,
  WEBHOOK_PROCESSING_STATUSES,
  ARTIFACT_STATUSES,
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  FACTORY_UPLOAD_TASK_STATUSES,
  SHOPIFY_UPDATE_TASK_STATUSES,
  STATUS_VALUES_BY_GROUP,
};

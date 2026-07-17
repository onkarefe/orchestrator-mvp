import {
  ARTIFACT_STATUSES,
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  JOB_STATUSES,
  ORDER_STATUSES,
  SHOPIFY_UPDATE_TASK_STATUSES,
  STATUS_GROUPS,
  STATUS_VALUES_BY_GROUP,
  WEBHOOK_PROCESSING_STATUSES,
} from '../constants/statuses.js';

const GROUP_ALIASES = Object.freeze({
  orders: STATUS_GROUPS.ORDER,
  jobs: STATUS_GROUPS.JOB,
  webhook: STATUS_GROUPS.WEBHOOK_PROCESSING,
  webhooks: STATUS_GROUPS.WEBHOOK_PROCESSING,
  artifact_validation: STATUS_GROUPS.ARTIFACT,
  artifacts: STATUS_GROUPS.ARTIFACT,
  factory_callback: STATUS_GROUPS.FACTORY_CALLBACK_PROCESSING,
  factory_callbacks: STATUS_GROUPS.FACTORY_CALLBACK_PROCESSING,
  shopify_update: STATUS_GROUPS.SHOPIFY_UPDATE_TASK,
  shopify_update_tasks: STATUS_GROUPS.SHOPIFY_UPDATE_TASK,
});

const ORDER_STATUS_RANK = Object.freeze({
  [ORDER_STATUSES.RECEIVED]: 0,
  [ORDER_STATUSES.VALIDATED]: 1,
  [ORDER_STATUSES.PROCESSING]: 2,
  [ORDER_STATUSES.ARTIFACT_READY]: 3,
  [ORDER_STATUSES.COMPLETED]: 4,
  [ORDER_STATUSES.FACTORY_RECEIVED]: 5,
  [ORDER_STATUSES.PRODUCTION_STARTED]: 6,
  [ORDER_STATUSES.PRODUCTION_COMPLETED]: 7,
  [ORDER_STATUSES.READY_FOR_SHIPPING]: 8,
  [ORDER_STATUSES.SHIPPED]: 9,
});

const TERMINAL_STATUSES_BY_GROUP = Object.freeze({
  [STATUS_GROUPS.ORDER]: Object.freeze([
    ORDER_STATUSES.MANUAL_REVIEW,
    ORDER_STATUSES.FAILED,
    ORDER_STATUSES.SHIPPED,
  ]),
  [STATUS_GROUPS.JOB]: Object.freeze([
    JOB_STATUSES.MANUAL_REVIEW,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.COMPLETED,
  ]),
  [STATUS_GROUPS.WEBHOOK_PROCESSING]: Object.freeze([
    WEBHOOK_PROCESSING_STATUSES.PROCESSED,
    WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
    WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC,
    WEBHOOK_PROCESSING_STATUSES.FAILED,
  ]),
  [STATUS_GROUPS.ARTIFACT]: Object.freeze([
    ARTIFACT_STATUSES.INVALID,
    ARTIFACT_STATUSES.AVAILABLE,
    ARTIFACT_STATUSES.FAILED,
  ]),
  [STATUS_GROUPS.FACTORY_CALLBACK_PROCESSING]: Object.freeze([
    FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
    FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
    FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
    FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED,
  ]),
  [STATUS_GROUPS.SHOPIFY_UPDATE_TASK]: Object.freeze([
    SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED,
    SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED,
    SHOPIFY_UPDATE_TASK_STATUSES.FAILED,
    SHOPIFY_UPDATE_TASK_STATUSES.MANUAL_REVIEW,
  ]),
});

const TRANSITIONS_BY_GROUP = Object.freeze({
  [STATUS_GROUPS.JOB]: Object.freeze({
    [JOB_STATUSES.PENDING]: Object.freeze([
      JOB_STATUSES.VALIDATING,
      JOB_STATUSES.PROCESSING,
      JOB_STATUSES.MANUAL_REVIEW,
      JOB_STATUSES.FAILED,
    ]),
    [JOB_STATUSES.VALIDATING]: Object.freeze([
      JOB_STATUSES.PROCESSING,
      JOB_STATUSES.MANUAL_REVIEW,
      JOB_STATUSES.FAILED,
    ]),
    [JOB_STATUSES.PROCESSING]: Object.freeze([
      JOB_STATUSES.ARTIFACT_GENERATED,
      JOB_STATUSES.COMPLETED,
      JOB_STATUSES.MANUAL_REVIEW,
      JOB_STATUSES.FAILED,
    ]),
    [JOB_STATUSES.ARTIFACT_GENERATED]: Object.freeze([
      JOB_STATUSES.COMPLETED,
      JOB_STATUSES.MANUAL_REVIEW,
      JOB_STATUSES.FAILED,
    ]),
  }),
  [STATUS_GROUPS.WEBHOOK_PROCESSING]: Object.freeze({
    [WEBHOOK_PROCESSING_STATUSES.PENDING]: Object.freeze([
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      WEBHOOK_PROCESSING_STATUSES.PROCESSED,
      WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
      WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
    ]),
    [WEBHOOK_PROCESSING_STATUSES.PROCESSING]: Object.freeze([
      WEBHOOK_PROCESSING_STATUSES.PROCESSED,
      WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
      WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
    ]),
  }),
  [STATUS_GROUPS.ARTIFACT]: Object.freeze({
    [ARTIFACT_STATUSES.PENDING]: Object.freeze([
      ARTIFACT_STATUSES.VALID,
      ARTIFACT_STATUSES.INVALID,
      ARTIFACT_STATUSES.FAILED,
    ]),
    [ARTIFACT_STATUSES.VALID]: Object.freeze([
      ARTIFACT_STATUSES.AVAILABLE,
      ARTIFACT_STATUSES.INVALID,
      ARTIFACT_STATUSES.FAILED,
    ]),
  }),
  [STATUS_GROUPS.FACTORY_CALLBACK_PROCESSING]: Object.freeze({
    [FACTORY_CALLBACK_PROCESSING_STATUSES.RECEIVED]: Object.freeze([
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSING,
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
      FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
      FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
      FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED,
    ]),
    [FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSING]: Object.freeze([
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
      FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
      FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
      FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED,
    ]),
  }),
  [STATUS_GROUPS.SHOPIFY_UPDATE_TASK]: Object.freeze({
    [SHOPIFY_UPDATE_TASK_STATUSES.PENDING]: Object.freeze([
      SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
      SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED,
      SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED,
      SHOPIFY_UPDATE_TASK_STATUSES.FAILED,
      SHOPIFY_UPDATE_TASK_STATUSES.MANUAL_REVIEW,
    ]),
    [SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING]: Object.freeze([
      SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED,
      SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED,
      SHOPIFY_UPDATE_TASK_STATUSES.FAILED,
      SHOPIFY_UPDATE_TASK_STATUSES.MANUAL_REVIEW,
    ]),
  }),
});

function normalizeGroup(group) {
  return GROUP_ALIASES[group] ?? group;
}

function isEmptyStatus(status) {
  return status === null || status === undefined || status === '';
}

export function isKnownStatus(group, status) {
  const normalizedGroup = normalizeGroup(group);
  const values = STATUS_VALUES_BY_GROUP[normalizedGroup];

  return Boolean(values?.includes(status));
}

export function assertKnownStatus(group, status) {
  const normalizedGroup = normalizeGroup(group);

  if (!STATUS_VALUES_BY_GROUP[normalizedGroup]) {
    throw new Error(`Unknown status group: ${group}`);
  }

  if (!isKnownStatus(normalizedGroup, status)) {
    throw new Error(`Unknown status "${status}" for group "${normalizedGroup}"`);
  }

  return status;
}

export function isTerminalStatus(group, status) {
  const normalizedGroup = normalizeGroup(group);

  return Boolean(TERMINAL_STATUSES_BY_GROUP[normalizedGroup]?.includes(status));
}

export function isManualReviewStatus(status) {
  return status === ORDER_STATUSES.MANUAL_REVIEW;
}

function canTransitionOrder(fromStatus, toStatus) {
  if (isTerminalStatus(STATUS_GROUPS.ORDER, fromStatus)) {
    return fromStatus === toStatus;
  }

  if (
    toStatus === ORDER_STATUSES.MANUAL_REVIEW ||
    toStatus === ORDER_STATUSES.FAILED
  ) {
    return true;
  }

  return ORDER_STATUS_RANK[toStatus] >= ORDER_STATUS_RANK[fromStatus];
}

export function canTransition(group, fromStatus, toStatus) {
  const normalizedGroup = normalizeGroup(group);

  if (!isKnownStatus(normalizedGroup, toStatus)) {
    return false;
  }

  if (isEmptyStatus(fromStatus)) {
    return true;
  }

  if (!isKnownStatus(normalizedGroup, fromStatus)) {
    return false;
  }

  if (fromStatus === toStatus) {
    return true;
  }

  if (isTerminalStatus(normalizedGroup, fromStatus)) {
    return false;
  }

  if (normalizedGroup === STATUS_GROUPS.ORDER) {
    return canTransitionOrder(fromStatus, toStatus);
  }

  return Boolean(
    TRANSITIONS_BY_GROUP[normalizedGroup]?.[fromStatus]?.includes(toStatus)
  );
}

export function assertCanTransition(group, fromStatus, toStatus) {
  const normalizedGroup = normalizeGroup(group);

  if (!canTransition(normalizedGroup, fromStatus, toStatus)) {
    throw new Error(
      `Invalid status transition for group "${normalizedGroup}": "${fromStatus}" -> "${toStatus}"`
    );
  }

  return toStatus;
}

export default {
  isKnownStatus,
  assertKnownStatus,
  canTransition,
  assertCanTransition,
  isTerminalStatus,
  isManualReviewStatus,
};

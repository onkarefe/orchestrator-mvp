import { JOB_STATUSES } from '../constants/statuses.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  createJob,
  findJobByShopifyOrderAndLineItem,
  listJobs,
} from '../models/JobModel.js';
import { validateConfiguratorLineItem } from './PreflightValidationService.js';

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function formatManualReviewReason(validation) {
  return validation.errors.length
    ? validation.errors.join(', ')
    : validation.reason;
}

async function createJobWithDuplicateFallback(
  jobData,
  { shopifyOrderId, shopifyLineItemId, db }
) {
  try {
    return {
      job: await createJob(jobData, db),
      duplicate: false,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existingJob = await findJobByShopifyOrderAndLineItem(
      shopifyOrderId,
      shopifyLineItemId,
      db
    );

    if (!existingJob) {
      throw error;
    }

    return {
      job: existingJob,
      duplicate: true,
    };
  }
}

export async function createConfiguratorJobFromLineItem(
  orderId,
  lineItem,
  { shopifyOrderId = null, db = undefined } = {}
) {
  const validation = validateConfiguratorLineItem(lineItem);

  if (!validation.isConfigurable) {
    return {
      job: null,
      created: false,
      duplicate: false,
      manualReview: false,
      reason: 'non_configurable_line_item',
      errors: [],
    };
  }

  const shopifyLineItemId = lineItem.id ?? null;
  const existingJob = await findJobByShopifyOrderAndLineItem(
    shopifyOrderId,
    shopifyLineItemId,
    db
  );

  if (existingJob) {
    return {
      job: existingJob,
      created: false,
      duplicate: true,
      manualReview: existingJob.status === JOB_STATUSES.MANUAL_REVIEW,
      reason: 'duplicate_line_item',
      errors: [],
    };
  }

  const configuratorPayload = validation.configuratorPayload;
  const masterAssetId = stringOrNull(configuratorPayload?.master_asset_id);
  const manualReviewReason = validation.ok
    ? null
    : formatManualReviewReason(validation);

  if (!validation.ok) {
    const creationResult = await createJobWithDuplicateFallback(
      {
        orderId,
        shopifyOrderId,
        shopifyLineItemId,
        productTitle: lineItem.title ?? lineItem.name ?? null,
        variantTitle: lineItem.variant_title ?? null,
        sku: stringOrNull(lineItem.sku),
        masterAssetId,
        widthMm: numberOrNull(configuratorPayload?.output?.width),
        heightMm: numberOrNull(configuratorPayload?.output?.height),
        cropRatioJson: objectOrNull(configuratorPayload?.crop_ratio),
        status: JOB_STATUSES.MANUAL_REVIEW,
        manualReviewReason,
        rawPayloadJson: {
          lineItem,
          configuratorPayload,
          preflightValidation: {
            ok: validation.ok,
            reason: validation.reason,
            errors: validation.errors,
          },
        },
      },
      { shopifyOrderId, shopifyLineItemId, db }
    );

    if (creationResult.duplicate) {
      return {
        job: creationResult.job,
        created: false,
        duplicate: true,
        manualReview:
          creationResult.job.status === JOB_STATUSES.MANUAL_REVIEW,
        reason: 'duplicate_line_item',
        errors: [],
      };
    }

    return {
      job: creationResult.job,
      created: true,
      duplicate: false,
      manualReview: true,
      reason: validation.reason,
      errors: validation.errors,
    };
  }

  const creationResult = await createJobWithDuplicateFallback(
    {
      orderId,
      shopifyOrderId,
      shopifyLineItemId,
      productTitle: lineItem.title ?? lineItem.name ?? null,
      variantTitle: lineItem.variant_title ?? null,
      sku: stringOrNull(lineItem.sku),
      masterAssetId,
      widthMm: configuratorPayload.output.width,
      heightMm: configuratorPayload.output.height,
      cropRatioJson: configuratorPayload.crop_ratio,
      rawPayloadJson: {
        lineItem,
        configuratorPayload,
        preflightValidation: {
          ok: validation.ok,
          reason: validation.reason,
          errors: validation.errors,
        },
      },
      status: JOB_STATUSES.PENDING,
    },
    { shopifyOrderId, shopifyLineItemId, db }
  );

  if (creationResult.duplicate) {
    return {
      job: creationResult.job,
      created: false,
      duplicate: true,
      manualReview: creationResult.job.status === JOB_STATUSES.MANUAL_REVIEW,
      reason: 'duplicate_line_item',
      errors: [],
    };
  }

  return {
    job: creationResult.job,
    created: true,
    duplicate: false,
    manualReview: false,
    reason: null,
    errors: [],
  };
}

export function getJobs(filters) {
  return listJobs(filters);
}

export default {
  createConfiguratorJobFromLineItem,
  getJobs,
};

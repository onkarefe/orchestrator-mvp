import { ORDER_STATUSES } from '../constants/statuses.js';
import pool from '../db/connection.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  createOrder,
  findOrderByShopifyOrderId,
  updateOrderManualReview,
  updateOrderStatus,
} from '../models/OrderModel.js';
import { updateJobManualReview } from '../models/JobModel.js';
import {
  createOrderLineItem,
  listOrderLineItemsByOrderId,
} from '../models/OrderLineItemModel.js';
import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';
import { createConfiguratorJobFromLineItem } from './JobService.js';
import { classifyShopifyLineItem } from './LineItemRoutingService.js';
import {
  MANUAL_REVIEW_REASONS,
  validateShopifyShippingAddress,
} from './PreflightValidationService.js';
import { logError, logInfo } from './LogService.js';

const ORDER_BLOCKED_BY_MANUAL_REVIEW_REASON =
  'order_blocked_by_manual_review';

function getCustomerName(payload) {
  if (payload.shipping_address?.name) {
    return payload.shipping_address.name;
  }

  if (payload.billing_address?.name) {
    return payload.billing_address.name;
  }

  const firstName = payload.customer?.first_name ?? '';
  const lastName = payload.customer?.last_name ?? '';
  const fullName = `${firstName} ${lastName}`.trim();

  return fullName || null;
}

async function writeInfoLogs(logEvents) {
  for (const logEvent of logEvents) {
    await logInfo(logEvent);
  }
}

export function getOrderSafetyManualReviewReasons(payload) {
  const reasons = new Set();
  const shippingValidation = validateShopifyShippingAddress(payload);

  if (!shippingValidation.ok) {
    reasons.add(shippingValidation.reason);
  }

  for (const lineItem of Array.isArray(payload?.line_items)
    ? payload.line_items
    : []) {
    if (typeof lineItem?.sku !== 'string' || !lineItem.sku.trim()) {
      reasons.add(MANUAL_REVIEW_REASONS.MISSING_SKU);
    }
  }

  return Array.from(reasons);
}

export function getOrderPreflightDisposition({
  pendingJobs = [],
  manualReviewJobs = [],
  manualReviewReasons = [],
} = {}) {
  const requiresManualReview =
    manualReviewJobs.length > 0 || manualReviewReasons.length > 0;

  return {
    requiresManualReview,
    pendingJobCount: requiresManualReview ? 0 : pendingJobs.length,
    blockedPendingJobCount: requiresManualReview ? pendingJobs.length : 0,
    manualReviewJobCount:
      manualReviewJobs.length + (requiresManualReview ? pendingJobs.length : 0),
  };
}

export async function createOrderAndJobsFromShopifyPayload(payload) {
  const shopifyOrderId = payload?.id;

  if (!shopifyOrderId) {
    throw new Error('Shopify order id is required');
  }

  const connection = await pool.getConnection();
  const logEvents = [];
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const existingOrder = await findOrderByShopifyOrderId(
      shopifyOrderId,
      connection
    );

    if (existingOrder) {
      const existingLineItems = await listOrderLineItemsByOrderId(
        existingOrder.id,
        connection
      );
      await connection.commit();
      transactionStarted = false;

      await logInfo({
        scopeType: 'order',
        orderId: existingOrder.id,
        step: 'order.duplicate_shopify_order',
        message: 'Duplicate Shopify order webhook ignored',
        detailsJson: {
          shopifyOrderId,
          shopifyOrderNumber: existingOrder.shopify_order_number,
        },
      });

      return {
        order: existingOrder,
        jobs: [],
        created: false,
        duplicate: true,
        skippedDuplicateJobs: [],
        manualReviewJobs: [],
        lineItems: existingLineItems,
      };
    }

    let order = await createOrder(
      {
        shopifyOrderId,
        shopifyOrderNumber: payload.name ?? payload.order_number ?? null,
        customerName: getCustomerName(payload),
        customerEmail: payload.email ?? payload.customer?.email ?? null,
        financialStatus: payload.financial_status ?? null,
        status: ORDER_STATUSES.RECEIVED,
        rawPayloadJson: payload,
      },
      connection
    );

    logEvents.push({
      scopeType: 'order',
      orderId: order.id,
      step: 'order.created',
      message: 'Order created from Shopify webhook',
      detailsJson: {
        shopifyOrderId,
        shopifyOrderNumber: order.shopify_order_number,
      },
    });

    const jobs = [];
    const skippedDuplicateJobs = [];
    const manualReviewJobs = [];
    const lineItemRecords = [];
    const manualReviewReasons = new Set(
      getOrderSafetyManualReviewReasons(payload)
    );
    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
    const shippingValidation = validateShopifyShippingAddress(payload);

    if (!shippingValidation.ok) {
      manualReviewReasons.add(shippingValidation.reason);
      logEvents.push({
        scopeType: 'order',
        orderId: order.id,
        step: 'order.shipping_address_manual_review',
        message: 'Shopify shipping address requires manual review',
        detailsJson: {
          reason: shippingValidation.reason,
          invalidFields: shippingValidation.errors,
        },
      });
    }

    for (const [sourcePosition, lineItem] of lineItems.entries()) {
      const routing = classifyShopifyLineItem(lineItem);
      const persisted = await createOrderLineItem(
        {
          orderId: order.id,
          shopifyOrderId,
          shopifyLineItemId: lineItem?.id ?? null,
          sourcePosition,
          sku:
            typeof lineItem?.sku === 'string' && lineItem.sku.trim()
              ? lineItem.sku.trim()
              : null,
          title: lineItem?.title ?? lineItem?.name ?? null,
          quantity:
            Number.isSafeInteger(lineItem?.quantity) && lineItem.quantity >= 0
              ? lineItem.quantity
              : 0,
          classification: routing.classification,
          routingState: routing.routingState,
          routingReason: routing.routingReason,
        },
        connection
      );

      lineItemRecords.push(persisted.lineItem);
      if (routing.routingState === LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED) {
        manualReviewReasons.add(routing.routingReason);
      }
      logEvents.push({
        scopeType: 'order',
        orderId: order.id,
        step: 'order.line_item_classified',
        message: 'Shopify line item classified for orchestration',
        detailsJson: {
          shopifyLineItemId: persisted.lineItem.shopify_line_item_id,
          sourcePosition,
          classification: persisted.lineItem.classification,
          routingState: persisted.lineItem.routing_state,
          routingReason: persisted.lineItem.routing_reason,
        },
      });

      if (!persisted.lineItem.sku) {
        manualReviewReasons.add(MANUAL_REVIEW_REASONS.MISSING_SKU);
        logEvents.push({
          scopeType: 'order',
          orderId: order.id,
          step: 'order.line_item_missing_sku',
          message: 'Shopify line item without SKU requires manual review',
          detailsJson: {
            shopifyLineItemId: persisted.lineItem.shopify_line_item_id,
            sourcePosition,
            reason: MANUAL_REVIEW_REASONS.MISSING_SKU,
          },
        });
      }

      if (routing.classification !== LINE_ITEM_CLASSIFICATIONS.WALLPAPER) {
        continue;
      }

      const result = await createConfiguratorJobFromLineItem(
        order.id,
        lineItem,
        {
          shopifyOrderId,
          db: connection,
        }
      );

      if (!result?.job) {
        continue;
      }

      if (result.duplicate) {
        skippedDuplicateJobs.push(result.job);

        logEvents.push({
          scopeType: 'job',
          orderId: result.job.order_id ?? order.id,
          jobId: result.job.id,
          step: 'job.duplicate_line_item_skipped',
          message: 'Duplicate Shopify line item job skipped',
          detailsJson: {
            shopifyOrderId,
            shopifyLineItemId: result.job.shopify_line_item_id,
          },
        });

        continue;
      }

      if (result.manualReview) {
        manualReviewJobs.push(result.job);

        if (result.reason) {
          manualReviewReasons.add(result.reason);
        }

        logEvents.push({
          scopeType: 'job',
          orderId: order.id,
          jobId: result.job.id,
          step: 'job.manual_review_created',
          message: 'Configurator job requires manual review',
          detailsJson: {
            shopifyLineItemId: result.job.shopify_line_item_id,
            reason: result.reason,
            errors: result.errors,
          },
        });

        continue;
      }

      jobs.push(result.job);

      logEvents.push({
        scopeType: 'job',
        orderId: order.id,
        jobId: result.job.id,
        step: 'job.created',
        message: 'Configurator job created from Shopify line item',
        detailsJson: {
          shopifyLineItemId: result.job.shopify_line_item_id,
          productTitle: result.job.product_title,
        },
      });
    }

    const preflightDisposition = getOrderPreflightDisposition({
      pendingJobs: jobs,
      manualReviewJobs,
      manualReviewReasons: Array.from(manualReviewReasons),
    });

    if (preflightDisposition.requiresManualReview) {
      const blockedPendingJobs = jobs.splice(0, jobs.length);

      for (const job of blockedPendingJobs) {
        const manualReviewJob = await updateJobManualReview(
          job.id,
          ORDER_BLOCKED_BY_MANUAL_REVIEW_REASON,
          connection
        );

        manualReviewJobs.push(manualReviewJob);

        logEvents.push({
          scopeType: 'job',
          orderId: order.id,
          jobId: manualReviewJob.id,
          step: 'job.manual_review_order_block',
          message: 'Configurator job blocked because order requires manual review',
          detailsJson: {
            shopifyLineItemId: manualReviewJob.shopify_line_item_id,
            reason: ORDER_BLOCKED_BY_MANUAL_REVIEW_REASON,
          },
        });
      }

      const manualReviewReason = Array.from(manualReviewReasons).join(', ');

      order = await updateOrderManualReview(
        order.id,
        manualReviewReason || 'manual_review',
        connection
      );

      logEvents.push({
        scopeType: 'order',
        orderId: order.id,
        step: 'order.manual_review',
        message: 'Order requires manual review before production',
        detailsJson: {
          shopifyOrderId,
          manualReviewJobCount: manualReviewJobs.length,
          reasons: Array.from(manualReviewReasons),
        },
      });
    } else if (jobs.length > 0) {
      order = await updateOrderStatus(order.id, 'queued', connection);
    } else {
      order = await updateOrderStatus(
        order.id,
        ORDER_STATUSES.RECEIVED,
        connection
      );

      logEvents.push({
        scopeType: 'order',
        orderId: order.id,
        step: 'order.no_configurator_jobs',
        message: 'Order did not contain configurator jobs',
        detailsJson: {
          shopifyOrderId,
        },
      });
    }

    await connection.commit();
    transactionStarted = false;
    await writeInfoLogs(logEvents);

    return {
      order,
      jobs,
      created: true,
      duplicate: false,
      skippedDuplicateJobs,
      manualReviewJobs,
      lineItems: lineItemRecords,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
    }

    if (isDuplicateKeyError(error)) {
      const existingOrder = await findOrderByShopifyOrderId(shopifyOrderId);

      if (existingOrder) {
        const existingLineItems = await listOrderLineItemsByOrderId(
          existingOrder.id
        );
        await logInfo({
          scopeType: 'order',
          orderId: existingOrder.id,
          step: 'order.concurrent_duplicate_shopify_order',
          message: 'Concurrent duplicate Shopify order ignored',
          detailsJson: {
            shopifyOrderId,
            shopifyOrderNumber: existingOrder.shopify_order_number,
          },
        });

        return {
          order: existingOrder,
          jobs: [],
          created: false,
          duplicate: true,
          skippedDuplicateJobs: [],
          manualReviewJobs: [],
          lineItems: existingLineItems,
        };
      }
    }

    await logError({
      scopeType: 'system',
      step: 'order.create_failed',
      message: 'Failed to create order/jobs from Shopify webhook',
      detailsJson: {
        shopifyOrderId,
        errorMessage: error.message,
      },
    });

    throw error;
  } finally {
    connection.release();
  }
}

export default {
  createOrderAndJobsFromShopifyPayload,
  getOrderPreflightDisposition,
  getOrderSafetyManualReviewReasons,
};

import { ORDER_STATUSES } from '../constants/statuses.js';
import pool from '../db/connection.js';
import {
  createOrder,
  findOrderByShopifyOrderId,
  updateOrderStatus,
} from '../models/OrderModel.js';
import { createConfiguratorJobFromLineItem } from './JobService.js';
import { logError, logInfo } from './LogService.js';

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
    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    for (const lineItem of lineItems) {
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

    if (jobs.length > 0) {
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
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
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
};

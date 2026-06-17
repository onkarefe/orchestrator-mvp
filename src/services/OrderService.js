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

export async function createOrderAndJobsFromShopifyPayload(payload) {
  const shopifyOrderId = payload?.id;

  if (!shopifyOrderId) {
    throw new Error('Shopify order id is required');
  }

  const existingOrder = await findOrderByShopifyOrderId(shopifyOrderId);

  if (existingOrder) {
    return {
      order: existingOrder,
      jobs: [],
      created: false,
    };
  }

  let order = await createOrder({
    shopifyOrderId,
    shopifyOrderNumber: payload.name ?? payload.order_number ?? null,
    customerName: getCustomerName(payload),
    customerEmail: payload.email ?? payload.customer?.email ?? null,
    financialStatus: payload.financial_status ?? null,
    status: 'received',
    rawPayloadJson: payload,
  });

  await logInfo({
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
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  for (const lineItem of lineItems) {
    try {
      const job = await createConfiguratorJobFromLineItem(order.id, lineItem);

      if (!job) {
        continue;
      }

      jobs.push(job);

      await logInfo({
        scopeType: 'job',
        orderId: order.id,
        jobId: job.id,
        step: 'job.created',
        message: 'Configurator job created from Shopify line item',
        detailsJson: {
          shopifyLineItemId: job.shopify_line_item_id,
          productTitle: job.product_title,
        },
      });
    } catch (error) {
      await logError({
        scopeType: 'order',
        orderId: order.id,
        step: 'job.create_failed',
        message: 'Failed to create configurator job',
        detailsJson: {
          lineItemId: lineItem?.id ?? null,
          errorMessage: error.message,
        },
      });

      throw error;
    }
  }

  if (jobs.length > 0) {
    order = await updateOrderStatus(order.id, 'queued');
  } else {
    order = await updateOrderStatus(order.id, 'received');

    await logInfo({
      scopeType: 'order',
      orderId: order.id,
      step: 'order.no_configurator_jobs',
      message: 'Order did not contain configurator jobs',
      detailsJson: {
        shopifyOrderId,
      },
    });
  }

  return {
    order,
    jobs,
    created: true,
  };
}

export default {
  createOrderAndJobsFromShopifyPayload,
};

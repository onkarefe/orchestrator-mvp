import pool from '../db/connection.js';
import {
  blockFactoryUploadTaskForLifecycle,
  findFactoryUploadTaskByOrderPackageId,
} from '../models/FactoryUploadTaskModel.js';
import { blockOrderJobsForLifecycle } from '../models/JobModel.js';
import {
  findOrderByShopifyOrderIdForUpdate,
  updateOrderLifecycleState,
} from '../models/OrderModel.js';
import { findOrderFactoryPackageByOrderId } from '../models/OrderFactoryPackageModel.js';
import { logInfo, logWarning } from './LogService.js';

export const SHOPIFY_LIFECYCLE_STATES = Object.freeze({
  BLOCKED_BEFORE_DISPATCH: 'blocked_before_factory_dispatch',
  ATTENTION_AFTER_DISPATCH: 'factory_lifecycle_attention_required',
});

function lifecycleEventType(topic, payload) {
  if (topic === 'orders/cancelled' || payload?.cancelled_at) {
    return 'cancelled';
  }

  if (
    topic === 'refunds/create' ||
    ['refunded', 'voided', 'partially_refunded'].includes(
      String(payload?.financial_status ?? '').toLowerCase()
    )
  ) {
    return 'refunded';
  }

  return null;
}

export function getShopifyOrderIdForLifecycleEvent(topic, payload) {
  const value = topic === 'refunds/create' ? payload?.order_id : payload?.id;

  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : String(value).trim();
}

export function getOrderLifecycle(order) {
  const lifecycle = order?.raw_payload_json?.orchestrator_lifecycle;

  return lifecycle && typeof lifecycle === 'object' ? lifecycle : null;
}

function hasDispatchedToFactory({ order, orderPackage, uploadTask }) {
  const progress = Array.isArray(uploadTask?.uploaded_files_json)
    ? uploadTask.uploaded_files_json
    : [];
  const xmlFinalized = progress.some(
    (file) => file?.type === 'xml' && file?.status === 'renamed'
  );

  return Boolean(
    order?.ftp_uploaded_at ||
      order?.factory_order_id ||
      orderPackage?.nexo_order_id ||
      orderPackage?.factory_status ||
      xmlFinalized ||
      ['uploading', 'uploaded'].includes(uploadTask?.status)
  );
}

function shippingSnapshot(payload) {
  return {
    shipping_address: payload?.shipping_address ?? null,
    shipping_lines: Array.isArray(payload?.shipping_lines)
      ? payload.shipping_lines
      : [],
    phone: payload?.phone ?? null,
  };
}

function shippingChanged(currentPayload, incomingPayload) {
  return (
    JSON.stringify(shippingSnapshot(currentPayload)) !==
    JSON.stringify(shippingSnapshot(incomingPayload))
  );
}

function mergedShippingPayload(currentPayload, incomingPayload) {
  return {
    ...currentPayload,
    ...shippingSnapshot(incomingPayload),
  };
}

export async function applyShopifyLifecycleEvent({
  topic,
  payload,
  webhookId = null,
  runtime = {},
} = {}) {
  const getConnection = runtime.getConnection ?? (() => pool.getConnection());
  const findOrder =
    runtime.findOrderByShopifyOrderIdForUpdate ??
    findOrderByShopifyOrderIdForUpdate;
  const findPackage =
    runtime.findOrderFactoryPackageByOrderId ??
    findOrderFactoryPackageByOrderId;
  const findUploadTask =
    runtime.findFactoryUploadTaskByOrderPackageId ??
    findFactoryUploadTaskByOrderPackageId;
  const updateLifecycle =
    runtime.updateOrderLifecycleState ?? updateOrderLifecycleState;
  const blockJobs = runtime.blockOrderJobsForLifecycle ?? blockOrderJobsForLifecycle;
  const blockUploadTask =
    runtime.blockFactoryUploadTaskForLifecycle ??
    blockFactoryUploadTaskForLifecycle;
  const writeInfoLog = runtime.logInfo ?? logInfo;
  const writeWarningLog = runtime.logWarning ?? logWarning;
  const shopifyOrderId = getShopifyOrderIdForLifecycleEvent(topic, payload);

  if (!shopifyOrderId) {
    throw new Error('shopify_lifecycle_order_id_missing');
  }

  const connection = await getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const order = await findOrder(shopifyOrderId, connection);

    if (!order) {
      throw new Error('shopify_lifecycle_order_not_found');
    }

    const existingLifecycle = getOrderLifecycle(order);
    const orderPackage = await findPackage(order.id, connection, {
      forUpdate: true,
    });
    const uploadTask = orderPackage
      ? await findUploadTask(orderPackage.id, connection, { forUpdate: true })
      : null;
    const dispatched = hasDispatchedToFactory({
      order,
      orderPackage,
      uploadTask,
    });
    const eventType = lifecycleEventType(topic, payload);
    const didShippingChange =
      topic === 'orders/updated' &&
      shippingChanged(order.raw_payload_json, payload);

    if (existingLifecycle) {
      await connection.commit();
      transactionStarted = false;
      return {
        order,
        orderPackage,
        uploadTask,
        lifecycle: existingLifecycle,
        disposition: 'already_blocked',
      };
    }

    if (!eventType && !didShippingChange) {
      await connection.commit();
      transactionStarted = false;
      return {
        order,
        orderPackage,
        uploadTask,
        lifecycle: null,
        disposition: 'no_relevant_change',
      };
    }

    if (!eventType && didShippingChange && !dispatched && !orderPackage) {
      const updatedOrder = await updateLifecycle(
        order.id,
        {
          rawPayloadJson: mergedShippingPayload(
            order.raw_payload_json,
            payload
          ),
          financialStatus: payload?.financial_status ?? null,
          status: order.status,
          manualReviewReason: order.manual_review_reason,
        },
        connection
      );
      await connection.commit();
      transactionStarted = false;
      await writeInfoLog({
        scopeType: 'order',
        orderId: order.id,
        step: 'shopify_lifecycle.shipping_refreshed',
        message: 'Pre-dispatch Shopify shipping data refreshed',
        detailsJson: { webhookId, topic },
      });
      return {
        order: updatedOrder,
        orderPackage,
        uploadTask,
        lifecycle: null,
        disposition: 'shipping_refreshed',
      };
    }

    const reason = eventType
      ? `shopify_${eventType}_${
          dispatched ? 'after' : 'before'
        }_factory_dispatch`
      : dispatched
        ? 'shopify_shipping_changed_after_factory_dispatch'
        : 'shopify_shipping_changed_after_package_created';
    const lifecycle = {
      state: dispatched
        ? SHOPIFY_LIFECYCLE_STATES.ATTENTION_AFTER_DISPATCH
        : SHOPIFY_LIFECYCLE_STATES.BLOCKED_BEFORE_DISPATCH,
      reason,
      topic,
      webhook_id: webhookId,
      observed_at: new Date().toISOString(),
    };
    const nextRawPayload = {
      ...(didShippingChange && !dispatched
        ? mergedShippingPayload(order.raw_payload_json, payload)
        : order.raw_payload_json),
      orchestrator_lifecycle: lifecycle,
    };
    const updatedOrder = await updateLifecycle(
      order.id,
      {
        rawPayloadJson: nextRawPayload,
        financialStatus:
          payload?.financial_status ?? (eventType === 'refunded' ? 'refunded' : null),
        manualReviewReason: reason,
      },
      connection
    );

    if (!dispatched) {
      await blockJobs(order.id, reason, connection);
      await blockUploadTask(orderPackage?.id, reason, connection);
    }

    await connection.commit();
    transactionStarted = false;
    await writeWarningLog({
      scopeType: 'order',
      orderId: order.id,
      step: dispatched
        ? 'shopify_lifecycle.factory_attention_required'
        : 'shopify_lifecycle.factory_dispatch_blocked',
      message: dispatched
        ? 'Shopify lifecycle change requires factory-side resolution'
        : 'Shopify lifecycle change blocked factory dispatch',
      detailsJson: {
        webhookId,
        topic,
        reason,
        orderFactoryPackageId: orderPackage?.id ?? null,
        factoryUploadTaskId: uploadTask?.id ?? null,
      },
    });

    return {
      order: updatedOrder,
      orderPackage,
      uploadTask,
      lifecycle,
      disposition: dispatched
        ? 'factory_attention_required'
        : 'factory_dispatch_blocked',
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    connection.release();
  }
}

export default {
  SHOPIFY_LIFECYCLE_STATES,
  applyShopifyLifecycleEvent,
  getOrderLifecycle,
  getShopifyOrderIdForLifecycleEvent,
};

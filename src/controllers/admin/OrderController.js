import env from '../../config/env.js';
import { listArtifactsByOrderId } from '../../models/ArtifactModel.js';
import { listFactoryCallbacks } from '../../models/FactoryCallbackModel.js';
import { findFactoryUploadTaskByOrderPackageId } from '../../models/FactoryUploadTaskModel.js';
import { listJobs } from '../../models/JobModel.js';
import { listLogs } from '../../models/LogModel.js';
import { findOrderFactoryPackageByOrderId } from '../../models/OrderFactoryPackageModel.js';
import { listOrderLineItemsByOrderId } from '../../models/OrderLineItemModel.js';
import { findOrderById, listOrders } from '../../models/OrderModel.js';
import { listShopifyUpdateTasks } from '../../models/ShopifyUpdateTaskModel.js';
import { listWebhooks } from '../../models/WebhookModel.js';
import { buildOrderMonitoring } from '../../services/OrderMonitoringService.js';
import { redact } from '../../utils/redact.js';

function prettyJson(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    try {
      return JSON.stringify(redact(JSON.parse(value)), null, 2);
    } catch {
      return '[unparseable_json_string]';
    }
  }

  return JSON.stringify(redact(value), null, 2);
}

function renderPage(res, next, view, data) {
  res.render(view, data, (pageError, body) => {
    if (pageError) {
      next(pageError);
      return;
    }

    res.render('layouts/main', { title: data.title, body });
  });
}

const OrderController = {
  async index(req, res, next) {
    try {
      const title = 'Orders';
      const orders = await listOrders({ limit: 50, offset: 0 });

      renderPage(res, next, 'pages/orders', { title, orders });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const order = await findOrderById(req.params.id);

      if (!order) {
        res.status(404).send('Order not found');
        return;
      }

      const title = `Order #${order.id}`;
      const [
        jobs,
        logs,
        lineItems,
        artifacts,
        orderPackage,
        factoryCallbacks,
        shopifyUpdateTasks,
        webhooks,
      ] = await Promise.all([
        listJobs({ orderId: order.id, limit: 100, offset: 0 }),
        listLogs({ orderId: order.id, limit: 100, offset: 0 }),
        listOrderLineItemsByOrderId(order.id),
        listArtifactsByOrderId(order.id),
        findOrderFactoryPackageByOrderId(order.id),
        listFactoryCallbacks({ orderId: order.id, limit: 100, offset: 0 }),
        listShopifyUpdateTasks({ orderId: order.id, limit: 100, offset: 0 }),
        listWebhooks({
          shopifyOrderId: order.shopify_order_id,
          limit: 100,
          offset: 0,
        }),
      ]);
      const uploadTask = orderPackage
        ? await findFactoryUploadTaskByOrderPackageId(orderPackage.id)
        : null;
      const monitoring = buildOrderMonitoring({
        order,
        webhooks,
        lineItems,
        jobs,
        artifacts,
        orderPackage,
        uploadTask,
        factoryCallbacks,
        shopifyUpdateTasks,
        logs,
        staleMinutes: env.PROCESSING_STALE_LOCK_MINUTES,
      });

      renderPage(res, next, 'pages/order-detail', {
        title,
        order,
        jobs,
        logs,
        lineItems,
        artifacts,
        orderPackage,
        uploadTask,
        factoryCallbacks,
        shopifyUpdateTasks,
        webhooks,
        monitoring,
        rawPayloadJson: prettyJson(order.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default OrderController;

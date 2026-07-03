import { listJobs } from '../../models/JobModel.js';
import { listLogs } from '../../models/LogModel.js';
import { findOrderById, listOrders } from '../../models/OrderModel.js';
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
      const jobs = await listJobs({ orderId: order.id, limit: 100, offset: 0 });
      const logs = await listLogs({ orderId: order.id, limit: 100, offset: 0 });

      renderPage(res, next, 'pages/order-detail', {
        title,
        order,
        jobs,
        logs,
        rawPayloadJson: prettyJson(order.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default OrderController;

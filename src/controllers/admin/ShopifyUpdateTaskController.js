import {
  findShopifyUpdateTaskById,
  listShopifyUpdateTasks,
} from '../../models/ShopifyUpdateTaskModel.js';
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

const ShopifyUpdateTaskController = {
  async index(req, res, next) {
    try {
      const title = 'Shopify Update Tasks';
      const shopifyUpdateTasks = await listShopifyUpdateTasks({
        limit: 50,
        offset: 0,
      });

      renderPage(res, next, 'pages/shopify-update-tasks', {
        title,
        shopifyUpdateTasks,
      });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const shopifyUpdateTask = await findShopifyUpdateTaskById(req.params.id);

      if (!shopifyUpdateTask) {
        res.status(404).send('Shopify update task not found');
        return;
      }

      const title = `Shopify Update Task #${shopifyUpdateTask.id}`;

      renderPage(res, next, 'pages/shopify-update-task-detail', {
        title,
        shopifyUpdateTask,
        payloadJson: prettyJson(shopifyUpdateTask.payload_json),
        resultJson: prettyJson(shopifyUpdateTask.result_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default ShopifyUpdateTaskController;

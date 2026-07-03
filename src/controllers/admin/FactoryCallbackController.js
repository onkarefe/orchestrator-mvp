import {
  findFactoryCallbackById,
  listFactoryCallbacks,
} from '../../models/FactoryCallbackModel.js';
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

const FactoryCallbackController = {
  async index(req, res, next) {
    try {
      const title = 'Factory Callbacks';
      const factoryCallbacks = await listFactoryCallbacks({
        limit: 50,
        offset: 0,
      });

      renderPage(res, next, 'pages/factory-callbacks', {
        title,
        factoryCallbacks,
      });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const factoryCallback = await findFactoryCallbackById(req.params.id);

      if (!factoryCallback) {
        res.status(404).send('Factory callback not found');
        return;
      }

      const title = `Factory Callback #${factoryCallback.id}`;

      renderPage(res, next, 'pages/factory-callback-detail', {
        title,
        factoryCallback,
        headersJson: prettyJson(factoryCallback.headers_json),
        rawPayloadJson: prettyJson(factoryCallback.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default FactoryCallbackController;

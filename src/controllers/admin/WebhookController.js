import { getWebhook, getWebhooks } from '../../services/WebhookService.js';
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

const WebhookController = {
  async index(req, res, next) {
    try {
      const title = 'Webhook Inbox';
      const webhooks = await getWebhooks({ limit: 50, offset: 0 });

      renderPage(res, next, 'pages/webhooks', { title, webhooks });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const webhook = await getWebhook(req.params.id);

      if (!webhook) {
        res.status(404).send('Webhook not found');
        return;
      }

      const title = `Webhook #${webhook.id}`;

      renderPage(res, next, 'pages/webhook-detail', {
        title,
        webhook,
        headersJson: prettyJson(webhook.headers_json),
        rawPayloadJson: prettyJson(webhook.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default WebhookController;

'use strict';

const http = require('node:http');
const { verifySignature } = require('./hmac');

const MAX_BODY_BYTES = 1024 * 1024;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/**
 * The webhook handler does only cheap, local work: verify, parse, one SQLite
 * transaction. No network calls -> responds in milliseconds. The worker picks
 * the row up from the DB.
 */
function createApp({ repo, secret, onEnqueued = () => {}, log = console }) {
  async function handleWebhook(req, res) {
    const raw = await readRaw(req);

    if (!verifySignature(raw, req.headers['x-shop-hmac-sha256'], secret)) {
      return json(res, 401, { error: 'invalid signature' });
    }

    let order;
    try {
      order = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'body is not valid JSON' });
    }
    const orderId = order?.id;
    if (orderId === undefined || orderId === null || orderId === '') {
      return json(res, 400, { error: 'order id missing' });
    }

    const webhookId = req.headers['x-shop-webhook-id'] || null;
    const result = repo.ingestOrder({
      webhookId,
      orderId: String(orderId),
      payload: raw.toString('utf8'),
    });

    if (result.accepted) {
      log.info?.(`[webhook] order ${orderId} accepted (webhook ${webhookId})`);
      onEnqueued(String(orderId));
    } else {
      log.info?.(`[webhook] order ${orderId} duplicate by ${result.duplicate} (webhook ${webhookId})`);
    }
    // 200 for duplicates too: the store must stop retrying, it already succeeded once.
    return json(res, 200, { ok: true, orderId: String(orderId), duplicate: result.duplicate ?? false });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/webhooks/orders-create') {
        return await handleWebhook(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, orders: repo.stats() });
      }
      const m = url.pathname.match(/^\/orders\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const o = repo.getOrder(decodeURIComponent(m[1]));
        if (!o) return json(res, 404, { error: 'not found' });
        const { payload, ...rest } = o;
        return json(res, 200, rest);
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
      if (!err.status) log.error?.('[http] unhandled', err);
    }
  });
}

module.exports = { createApp };

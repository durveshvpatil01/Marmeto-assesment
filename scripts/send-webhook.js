'use strict';

/**
 * Sends a correctly signed orders/create webhook, then the exact same delivery again
 * (same X-Shop-Webhook-Id), then the same order under a NEW webhook id, then a request
 * with a bad signature.
 *
 *   npm run send                   # random order id
 *   npm run send -- 1001           # specific order id
 *   npm run send -- 1001 --once    # just one delivery
 */

const crypto = require('node:crypto');
const config = require('../src/config');

const args = process.argv.slice(2);
const orderId = args.find((a) => !a.startsWith('--')) || String(Date.now());
const once = args.includes('--once');
const url = process.env.WEBHOOK_URL || `http://localhost:${config.port}/webhooks/orders-create`;

const body = JSON.stringify({
  id: Number(orderId) || orderId,
  name: `#${orderId}`,
  email: 'customer@example.com',
  shipping_address: {
    name: 'Asha Rao',
    address1: '12 MG Road',
    city: 'Bengaluru',
    zip: '560001',
    country_code: 'IN',
  },
  line_items: [{ sku: 'TSHIRT-M', title: 'T-shirt', quantity: 2 }],
});

const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');

async function deliver(label, webhookId, signature) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shop-webhook-id': webhookId,
      'x-shop-hmac-sha256': signature,
    },
    body,
  });
  console.log(`${label.padEnd(28)} -> ${res.status} ${await res.text()} (${Date.now() - t0}ms)`);
}

(async () => {
  const sig = sign(body, config.webhookSecret);
  const webhookId = crypto.randomUUID();
  console.log(`order ${orderId}, webhook ${webhookId}\n`);
  console.log('curl equivalent:');
  console.log(
    `curl -X POST ${url} -H 'content-type: application/json' ` +
      `-H 'x-shop-webhook-id: ${webhookId}' -H 'x-shop-hmac-sha256: ${sig}' --data '${body}'\n`
  );

  await deliver('1. first delivery', webhookId, sig);
  if (once) return;
  await deliver('2. same webhook again', webhookId, sig);
  await deliver('3. same order, new webhook', crypto.randomUUID(), sig);
  await deliver('4. bad signature', crypto.randomUUID(), sign(body, 'wrong-secret'));
})().catch((err) => {
  console.error('send failed:', err.message);
  process.exit(1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { sign, verifySignature } = require('../src/hmac');

const SECRET = 'test-secret';
const silent = { info() {}, error() {} };

async function startApp() {
  const repo = openDb(':memory:');
  const server = createApp({ repo, secret: SECRET, log: silent });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/webhooks/orders-create`;
  return {
    repo,
    post: (body, headers = {}) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('verifySignature: accepts correct, rejects wrong / missing / malformed', () => {
  const body = Buffer.from('{"id":1}');
  assert.equal(verifySignature(body, sign(body, SECRET), SECRET), true);
  assert.equal(verifySignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, '', SECRET), false);
  assert.equal(verifySignature(body, 'not base64 !!', SECRET), false);
  assert.equal(verifySignature(body, 'c2hvcnQ=', SECRET), false); // wrong length, must not throw
});

test('signature is checked over raw bytes, not re-serialised JSON', () => {
  const raw = Buffer.from('{ "id" : 1,  "name":"caf\\u00e9" }');
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw)));
  assert.equal(verifySignature(raw, sign(raw, SECRET), SECRET), true);
  assert.equal(verifySignature(reserialised, sign(raw, SECRET), SECRET), false);
});

test('POST rejects bad signature with 401 and stores nothing', async () => {
  const app = await startApp();
  try {
    const body = JSON.stringify({ id: 1 });
    const res = await app.post(body, { 'x-shop-hmac-sha256': sign(body, 'wrong'), 'x-shop-webhook-id': 'w1' });
    assert.equal(res.status, 401);
    assert.equal(app.repo.getOrder('1'), null);
  } finally {
    await app.close();
  }
});

test('same webhook twice and same order under new webhook id -> one order row', async () => {
  const app = await startApp();
  try {
    const body = JSON.stringify({ id: 42, line_items: [] });
    const h = (id) => ({ 'x-shop-hmac-sha256': sign(body, SECRET), 'x-shop-webhook-id': id });

    const r1 = await app.post(body, h('w-1'));
    const r2 = await app.post(body, h('w-1'));
    const r3 = await app.post(body, h('w-2'));

    assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
    assert.equal((await r1.json()).duplicate, false);
    assert.equal((await r2.json()).duplicate, 'webhook');
    assert.equal((await r3.json()).duplicate, 'order');
    assert.equal(app.repo.allOrders().length, 1);
    assert.equal(app.repo.getOrder('42').status, 'pending');
  } finally {
    await app.close();
  }
});

test('concurrent duplicate deliveries still produce one order', async () => {
  const app = await startApp();
  try {
    const body = JSON.stringify({ id: 7 });
    const headers = { 'x-shop-hmac-sha256': sign(body, SECRET), 'x-shop-webhook-id': 'w-dup' };
    const results = await Promise.all(Array.from({ length: 10 }, () => app.post(body, headers)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(app.repo.allOrders().length, 1);
  } finally {
    await app.close();
  }
});

test('valid signature but bad JSON or no id -> 400', async () => {
  const app = await startApp();
  try {
    for (const body of ['not json', JSON.stringify({ name: 'no id' })]) {
      const res = await app.post(body, { 'x-shop-hmac-sha256': sign(body, SECRET) });
      assert.equal(res.status, 400);
    }
  } finally {
    await app.close();
  }
});

test('webhook responds fast (no courier work inline)', async () => {
  const app = await startApp();
  try {
    const body = JSON.stringify({ id: 99 });
    const t0 = Date.now();
    const res = await app.post(body, { 'x-shop-hmac-sha256': sign(body, SECRET), 'x-shop-webhook-id': 'w-fast' });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    await app.close();
  }
});

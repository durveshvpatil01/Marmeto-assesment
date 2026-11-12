'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { reconcile } = require('../src/reconcile');
const { createWorker } = require('../src/worker');
const { createCourierClient } = require('../src/courier');
const { createMockCourier } = require('../mock-courier');

const silent = { info() {}, warn() {}, error() {} };
const config = { leaseMs: 5000, maxAttempts: 2, backoffBaseMs: 10, backoffMaxMs: 20, pollMs: 10 };

async function setup() {
  const mock = createMockCourier({ fail500: 0, fail429: 0, hang: 0, hangMs: 1500 });
  const port = await mock.listen();
  const repo = openDb(':memory:');
  const courier = createCourierClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
  const worker = createWorker({ repo, courier, config, log: silent });
  const add = (id) => repo.ingestOrder({ webhookId: `w${id}`, orderId: String(id), payload: '{"id":1}' });
  return { mock, repo, courier, worker, add, close: async () => { await mock.close(); repo.close(); } };
}

test('dead order whose shipment the courier DID create is adopted, not re-created', async () => {
  const t = await setup();
  try {
    t.add(10);
    t.mock.setScript(['hang']); // courier creates it, we time out
    await t.worker.tick();
    // Simulate the job having been parked as dead before anyone checked the courier.
    t.repo.db.exec("UPDATE orders SET status='dead' WHERE order_id='10'");
    assert.equal(t.mock.shipments.get('10').length, 1);

    const s = await reconcile({ repo: t.repo, courier: t.courier, graceMs: 0, log: silent });
    assert.deepEqual(s, { checked: 1, adopted: 1, requeued: 0, errors: 0 });
    const o = t.repo.getOrder('10');
    assert.equal(o.status, 'shipped');
    assert.equal(o.shipment_id, t.mock.shipments.get('10')[0].shipmentId);
    assert.equal(t.mock.shipments.get('10').length, 1);
  } finally {
    await t.close();
  }
});

test('dead order with no shipment is requeued with a fresh budget and then shipped once', async () => {
  const t = await setup();
  try {
    t.add(11);
    t.mock.setScript(['500', '500']);
    await t.worker.tick();
    await t.worker.tick({ now: Date.now() + 60000 });
    assert.equal(t.repo.getOrder('11').status, 'dead');

    const s = await reconcile({ repo: t.repo, courier: t.courier, graceMs: 0, log: silent });
    assert.equal(s.requeued, 1);
    const o = t.repo.getOrder('11');
    assert.equal(o.status, 'pending');
    assert.equal(o.attempts, 0);

    await t.worker.tick();
    assert.equal(t.repo.getOrder('11').status, 'shipped');
    assert.equal(t.mock.shipments.get('11').length, 1);
  } finally {
    await t.close();
  }
});

test('running reconcile twice is harmless; shipped and actively-leased orders are left alone', async () => {
  const t = await setup();
  try {
    t.add(12);
    await t.worker.tick(); // shipped
    t.add(13);
    t.repo.claimNext({ leaseMs: 60000 }); // 13 is held by a live worker

    const a = await reconcile({ repo: t.repo, courier: t.courier, graceMs: 0, log: silent });
    const b = await reconcile({ repo: t.repo, courier: t.courier, graceMs: 0, log: silent });
    assert.equal(a.checked, 0);
    assert.equal(b.checked, 0);
    assert.equal(t.repo.getOrder('13').status, 'processing');
    assert.equal(t.mock.shipments.get('12').length, 1);
    assert.equal(t.mock.shipments.get('13'), undefined);
  } finally {
    await t.close();
  }
});

test('courier unreachable during reconcile -> order untouched, error counted', async () => {
  const t = await setup();
  try {
    t.add(14);
    t.repo.db.exec("UPDATE orders SET status='dead' WHERE order_id='14'");
    const down = createCourierClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 });
    const s = await reconcile({ repo: t.repo, courier: down, graceMs: 0, log: silent });
    assert.equal(s.errors, 1);
    assert.equal(t.repo.getOrder('14').status, 'dead');
  } finally {
    await t.close();
  }
});

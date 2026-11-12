'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createWorker, backoffMs } = require('../src/worker');
const { createCourierClient, parseRetryAfter } = require('../src/courier');
const { createMockCourier } = require('../mock-courier');

const silent = { info() {}, warn() {}, error() {} };
const FAR_FUTURE = () => Date.now() + 10 * 60 * 1000;

async function setup({ courierOpts = {}, cfg = {} } = {}) {
  const mock = createMockCourier({ fail500: 0, fail429: 0, hang: 0, hangMs: 1500, ...courierOpts });
  const port = await mock.listen();
  const repo = openDb(':memory:');
  const config = {
    leaseMs: 5000, maxAttempts: 5, backoffBaseMs: 100, backoffMaxMs: 1000, pollMs: 10,
    ...cfg,
  };
  const courier = createCourierClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
  const worker = createWorker({ repo, courier, config, log: silent });
  const addOrder = (id) =>
    repo.ingestOrder({ webhookId: `w-${id}`, orderId: String(id), payload: JSON.stringify({ id, line_items: [] }) });
  return {
    mock, repo, worker, addOrder,
    close: async () => { await mock.close(); repo.close(); },
  };
}

test('backoff grows exponentially, is capped, and never zero', () => {
  const cfg = { baseMs: 100, maxMs: 1000 };
  assert.equal(backoffMs(1, cfg, () => 0), 50);
  assert.equal(backoffMs(1, cfg, () => 1), 100);
  assert.equal(backoffMs(3, cfg, () => 1), 400);
  assert.equal(backoffMs(10, cfg, () => 1), 1000);
});

test('parseRetryAfter handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
});

test('happy path: one shipment, order marked shipped', async () => {
  const t = await setup();
  try {
    t.addOrder(1);
    assert.equal(await t.worker.tick(), true);
    const o = t.repo.getOrder('1');
    assert.equal(o.status, 'shipped');
    assert.equal(t.mock.shipments.get('1').length, 1);
    assert.equal(o.shipment_id, t.mock.shipments.get('1')[0].shipmentId);
  } finally {
    await t.close();
  }
});

test('timeout AFTER courier created the shipment -> retry adopts it, no duplicate', async () => {
  const t = await setup();
  try {
    t.addOrder(2);
    t.mock.setScript(['hang']); // creates shipment, then hangs past our 500ms timeout

    await t.worker.tick();
    let o = t.repo.getOrder('2');
    assert.equal(o.status, 'pending');
    assert.match(o.last_error, /^timeout/);
    assert.equal(t.mock.shipments.get('2').length, 1, 'courier did create it');

    await t.worker.tick({ now: FAR_FUTURE() }); // the retry
    o = t.repo.getOrder('2');
    assert.equal(o.status, 'shipped');
    assert.equal(t.mock.shipments.get('2').length, 1, 'still exactly one shipment');
    assert.equal(o.shipment_id, t.mock.shipments.get('2')[0].shipmentId);
  } finally {
    await t.close();
  }
});

test('429 schedules the retry using Retry-After', async () => {
  const t = await setup({ courierOpts: { retryAfterSec: 2 } });
  try {
    t.addOrder(3);
    t.mock.setScript(['429']);
    const before = Date.now();
    await t.worker.tick();
    const o = t.repo.getOrder('3');
    assert.equal(o.status, 'pending');
    assert.match(o.last_error, /^rate_limited/);
    const wait = o.next_attempt_at - before;
    assert.ok(wait >= 1900 && wait <= 2500, `expected ~2000ms, got ${wait}`);
    assert.equal(await t.worker.tick(), false, 'not due yet, so not claimed');
  } finally {
    await t.close();
  }
});

test('5xx retries with backoff, then succeeds', async () => {
  const t = await setup();
  try {
    t.addOrder(4);
    t.mock.setScript(['500', '500', 'ok']);
    await t.worker.tick();
    await t.worker.tick({ now: FAR_FUTURE() });
    await t.worker.tick({ now: FAR_FUTURE() });
    const o = t.repo.getOrder('4');
    assert.equal(o.status, 'shipped');
    assert.equal(o.attempts, 3);
    assert.equal(t.mock.shipments.get('4').length, 1);
  } finally {
    await t.close();
  }
});

test('after maxAttempts the job is parked as dead with the last error', async () => {
  const t = await setup({ cfg: { maxAttempts: 3 } });
  try {
    t.addOrder(5);
    t.mock.setScript(['500', '500', '500', '500']);
    for (let i = 0; i < 5; i++) await t.worker.tick({ now: FAR_FUTURE() });
    const o = t.repo.getOrder('5');
    assert.equal(o.status, 'dead');
    assert.equal(o.attempts, 3);
    assert.match(o.last_error, /server_error/);
    assert.equal(t.mock.shipments.get('5'), undefined);
  } finally {
    await t.close();
  }
});

test('crashed worker: expired lease is reclaimed and does not double-create', async () => {
  const t = await setup();
  try {
    t.addOrder(6);
    // Simulate: worker claimed, POST succeeded at courier, process died before saving.
    t.repo.claimNext({ leaseMs: 1000 });
    t.mock.shipments.set('6', [{ shipmentId: 'shp_from_crashed_run', reference: '6' }]);

    assert.equal(await t.worker.tick(), false, 'lease still held');
    await t.worker.tick({ now: Date.now() + 2000 });
    const o = t.repo.getOrder('6');
    assert.equal(o.status, 'shipped');
    assert.equal(o.shipment_id, 'shp_from_crashed_run');
    assert.equal(t.mock.shipments.get('6').length, 1);
  } finally {
    await t.close();
  }
});

test('chaos: 40 orders against random failures with concurrent workers -> no duplicates', async () => {
  const t = await setup({
    courierOpts: { fail500: 0.2, fail429: 0.1, hang: 0.1, hangMs: 1000, retryAfterSec: 0 },
    cfg: { maxAttempts: 25, backoffBaseMs: 5, backoffMaxMs: 20, leaseMs: 5000 },
  });
  const concurrentWorker = createWorker({
    repo: t.repo,
    courier: createCourierClient({ baseUrl: `http://127.0.0.1:${t.mock.server.address().port}`, timeoutMs: 400 }),
    config: { leaseMs: 5000, maxAttempts: 25, backoffBaseMs: 5, backoffMaxMs: 20, pollMs: 5 },
    log: silent,
    concurrency: 4,
  });
  try {
    for (let i = 100; i < 140; i++) t.addOrder(i);
    concurrentWorker.start();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = t.repo.stats();
      if ((s.shipped ?? 0) + (s.dead ?? 0) === 40) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await concurrentWorker.stop();

    const stats = t.repo.stats();
    assert.equal((stats.shipped ?? 0) + (stats.dead ?? 0), 40, JSON.stringify(stats));
    for (const [ref, list] of t.mock.shipments) {
      assert.equal(list.length, 1, `reference ${ref} has ${list.length} shipments`);
    }
    for (const o of t.repo.allOrders().filter((x) => x.status === 'shipped')) {
      assert.equal(o.shipment_id, t.mock.shipments.get(o.order_id)[0].shipmentId);
    }
  } finally {
    await concurrentWorker.stop();
    await t.close();
  }
});

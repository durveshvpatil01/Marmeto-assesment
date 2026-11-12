'use strict';

const { CourierError } = require('./courier');

/** Exponential backoff with "equal jitter": half fixed, half random. Never 0, never a thundering herd. */
function backoffMs(attempt, { baseMs, maxMs }, rand = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/**
 * How long to wait before the next attempt.
 *
 * A timeout is ambiguous: the courier may still commit the POST after we gave up.
 * GET-before-POST only protects us once that commit is visible, so after a timeout
 * we wait at least `ambiguousSettleMs` (set above the courier's worst-case commit
 * latency). Retrying sooner can find nothing, POST again and create a duplicate.
 */
function retryDelayMs(e, attempt, config) {
  if (e.kind === 'rate_limited' && e.retryAfterMs !== undefined) return e.retryAfterMs;
  const backoff = backoffMs(attempt, { baseMs: config.backoffBaseMs, maxMs: config.backoffMaxMs });
  if (e.kind === 'timeout') return Math.max(config.ambiguousSettleMs ?? 0, backoff);
  return backoff;
}

/**
 * Shipment creation for ONE order. The rule that prevents duplicates:
 *   always ask the courier "do you already have a shipment for this reference?"
 *   before POSTing. A previous attempt may have timed out after the courier
 *   created it, or our process may have crashed between POST and saving the result.
 */
async function shipOrder(order, courier, log) {
  const existing = await courier.findByReference(order.order_id);
  if (existing.length > 0) {
    if (existing.length > 1) {
      log.warn?.(`[worker] order ${order.order_id}: courier already has ${existing.length} shipments (pre-existing duplicate), adopting the first`);
    }
    return { shipmentId: existing[0].shipmentId, adopted: true };
  }

  const payload = JSON.parse(order.payload);
  const created = await courier.createShipment({
    reference: order.order_id,
    address: payload.shipping_address ?? null,
    items: (payload.line_items ?? []).map((li) => ({ sku: li.sku, quantity: li.quantity })),
  });
  return { shipmentId: created.shipmentId, adopted: false };
}

function createWorker({ repo, courier, config, log = console, concurrency = 1 }) {
  let running = false;
  let wakeUp = null;
  const loops = [];

  /** Claim and process a single due job. Returns true if a job was processed. */
  async function tick({ now = Date.now() } = {}) {
    const order = repo.claimNext({ now, leaseMs: config.leaseMs });
    if (!order) return false;

    try {
      const { shipmentId, adopted } = await shipOrder(order, courier, log);
      repo.markShipped(order.order_id, shipmentId);
      log.info?.(`[worker] order ${order.order_id} shipped ${shipmentId}${adopted ? ' (found existing at courier)' : ''} attempt=${order.attempts}`);
    } catch (err) {
      const e = err instanceof CourierError ? err : new CourierError('bad_response', err.message, { retryable: false });
      const msg = `${e.kind}: ${e.message}`;

      if (!e.retryable || order.attempts >= config.maxAttempts) {
        repo.markDead(order.order_id, msg);
        log.error?.(`[worker] order ${order.order_id} DEAD after ${order.attempts} attempt(s): ${msg}`);
        return true;
      }

      const delay = retryDelayMs(e, order.attempts, config);
      // Stored in the DB (next_attempt_at), so the wait holds for every worker process.
      repo.scheduleRetry(order.order_id, Date.now() + delay, msg);
      log.warn?.(`[worker] order ${order.order_id} attempt ${order.attempts} failed (${msg}); retry in ${delay}ms`);
    }
    return true;
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(t);
        resolve();
      };
    });

  async function loop() {
    while (running) {
      let worked = false;
      try {
        worked = await tick();
      } catch (err) {
        log.error?.('[worker] tick crashed', err);
      }
      if (!worked && running) await sleep(config.pollMs);
    }
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      for (let i = 0; i < concurrency; i++) loops.push(loop());
    },
    /** Nudge an idle loop so a freshly enqueued order is picked up without waiting a poll interval. */
    wake() {
      wakeUp?.();
    },
    async stop() {
      running = false;
      wakeUp?.();
      await Promise.all(loops.splice(0));
    },
  };
}

module.exports = { createWorker, backoffMs, retryDelayMs, shipOrder };

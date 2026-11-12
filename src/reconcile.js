'use strict';

/**
 * Find orders that should have a confirmed shipment but don't, and fix them
 * without ever creating a duplicate:
 *
 *   1. Ask the courier for shipments with reference = orderId.
 *   2. Found -> the courier did create it (e.g. it timed out on us). Adopt it.
 *   3. None  -> overdue pending order: make it due now, so the normal worker
 *               path (which also checks before POSTing) handles it.
 *               dead order: leave it parked. Dead means "a human should look"
 *               (a 400, or retries exhausted). Requeueing it automatically would
 *               loop forever: an order the courier always rejects would be
 *               re-POSTed every run. Use `npm run replay` once the cause is fixed.
 *
 * Reconcile never POSTs itself, so there is exactly one code path that creates shipments.
 * Orders currently leased by a live worker are skipped.
 */
async function reconcile({ repo, courier, now = Date.now(), graceMs = 60000, log = console }) {
  const summary = { checked: 0, adopted: 0, requeued: 0, parked: 0, errors: 0 };

  for (const order of repo.findUnconfirmed({ now, graceMs })) {
    summary.checked++;
    try {
      const existing = await courier.findByReference(order.order_id);
      if (existing.length > 0) {
        if (repo.adoptShipment(order.order_id, existing[0].shipmentId)) summary.adopted++;
        log.info?.(`[reconcile] order ${order.order_id} (${order.status}): courier has ${existing[0].shipmentId}, adopted`);
      } else if (order.status === 'dead') {
        summary.parked++;
        log.warn?.(`[reconcile] order ${order.order_id} is dead with no shipment at courier (${order.last_error}); needs a manual replay`);
      } else {
        if (repo.requeue(order.order_id)) summary.requeued++;
        log.info?.(`[reconcile] order ${order.order_id} (${order.status}): overdue, no shipment at courier, made due now`);
      }
    } catch (err) {
      summary.errors++;
      log.warn?.(`[reconcile] order ${order.order_id}: could not check courier (${err.message}), will try next run`);
    }
  }
  return summary;
}

module.exports = { reconcile };

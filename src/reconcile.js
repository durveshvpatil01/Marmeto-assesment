'use strict';

/**
 * Find orders that should have a confirmed shipment but don't, and fix them
 * without ever creating a duplicate:
 *
 *   1. Ask the courier for shipments with reference = orderId.
 *   2. Found  -> the courier did create it (e.g. it timed out on us). Adopt it.
 *   3. None   -> put the order back on the queue. The normal worker path
 *                (which also checks before POSTing) creates it.
 *
 * Reconcile never POSTs itself, so there is exactly one code path that creates shipments.
 * Orders currently leased by a live worker are skipped.
 */
async function reconcile({ repo, courier, now = Date.now(), graceMs = 60000, log = console }) {
  const summary = { checked: 0, adopted: 0, requeued: 0, errors: 0 };

  for (const order of repo.findUnconfirmed({ now, graceMs })) {
    summary.checked++;
    try {
      const existing = await courier.findByReference(order.order_id);
      if (existing.length > 0) {
        if (repo.adoptShipment(order.order_id, existing[0].shipmentId)) summary.adopted++;
        log.info?.(`[reconcile] order ${order.order_id} (${order.status}): courier has ${existing[0].shipmentId}, adopted`);
      } else {
        // A dead job gets a fresh retry budget; a stale pending one just becomes due now.
        if (repo.requeue(order.order_id, { resetAttempts: order.status === 'dead' })) summary.requeued++;
        log.info?.(`[reconcile] order ${order.order_id} (${order.status}): no shipment at courier, requeued`);
      }
    } catch (err) {
      summary.errors++;
      log.warn?.(`[reconcile] order ${order.order_id}: could not check courier (${err.message}), will try next run`);
    }
  }
  return summary;
}

module.exports = { reconcile };

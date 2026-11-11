'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * The orders table is both our record of the order AND the job queue.
 * One row per order_id (primary key) is what makes ingestion idempotent.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id         TEXT PRIMARY KEY,
  first_webhook_id TEXT,
  payload          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','shipped','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  locked_until     INTEGER,
  shipment_id      TEXT,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_due ON orders (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  webhook_id  TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return createRepo(db);
}

function createRepo(db) {
  const q = {
    seenWebhook: db.prepare('SELECT 1 FROM webhook_deliveries WHERE webhook_id = ?'),
    addWebhook: db.prepare(
      'INSERT OR IGNORE INTO webhook_deliveries (webhook_id, order_id, received_at) VALUES (?, ?, ?)'
    ),
    addOrder: db.prepare(`
      INSERT OR IGNORE INTO orders
        (order_id, first_webhook_id, payload, status, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)`),
    claim: db.prepare(`
      UPDATE orders
         SET status = 'processing', locked_until = :lockUntil,
             attempts = attempts + 1, updated_at = :now
       WHERE order_id = (
         SELECT order_id FROM orders
          WHERE (status = 'pending'    AND next_attempt_at <= :now)
             OR (status = 'processing' AND locked_until    <= :now)
          ORDER BY next_attempt_at
          LIMIT 1)
      RETURNING *`),
    shipped: db.prepare(`
      UPDATE orders SET status = 'shipped', shipment_id = ?, locked_until = NULL,
                        last_error = NULL, updated_at = ?
       WHERE order_id = ?`),
    retry: db.prepare(`
      UPDATE orders SET status = 'pending', next_attempt_at = ?, locked_until = NULL,
                        last_error = ?, updated_at = ?
       WHERE order_id = ? AND status = 'processing'`),
    dead: db.prepare(`
      UPDATE orders SET status = 'dead', locked_until = NULL, last_error = ?, updated_at = ?
       WHERE order_id = ? AND status = 'processing'`),
    get: db.prepare('SELECT * FROM orders WHERE order_id = ?'),
    unconfirmed: db.prepare(`
      SELECT * FROM orders
       WHERE status = 'dead'
          OR (status = 'pending'    AND next_attempt_at <= :staleBefore)
          OR (status = 'processing' AND locked_until    <= :now)
       ORDER BY created_at`),
    requeue: db.prepare(`
      UPDATE orders SET status = 'pending', next_attempt_at = ?, locked_until = NULL,
                        attempts = CASE WHEN ? THEN 0 ELSE attempts END, updated_at = ?
       WHERE order_id = ? AND status <> 'shipped'`),
    countByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
    all: db.prepare('SELECT * FROM orders ORDER BY created_at'),
  };

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    db,

    /**
     * Idempotent ingest. Returns { accepted: true } for a new order,
     * or { accepted: false, duplicate: 'webhook' | 'order' }.
     */
    ingestOrder({ webhookId, orderId, payload, now = Date.now() }) {
      return tx(() => {
        if (webhookId && q.seenWebhook.get(webhookId)) return { accepted: false, duplicate: 'webhook' };
        if (webhookId) q.addWebhook.run(webhookId, orderId, now);
        const r = q.addOrder.run(orderId, webhookId ?? null, payload, now, now, now);
        return r.changes === 1 ? { accepted: true } : { accepted: false, duplicate: 'order' };
      });
    },

    /** Atomically take the next due job (or an expired lease). */
    claimNext({ now = Date.now(), leaseMs }) {
      return q.claim.get({ now, lockUntil: now + leaseMs }) ?? null;
    },

    markShipped(orderId, shipmentId, now = Date.now()) {
      q.shipped.run(shipmentId, now, orderId);
    },
    scheduleRetry(orderId, nextAttemptAt, error, now = Date.now()) {
      q.retry.run(nextAttemptAt, error, now, orderId);
    },
    markDead(orderId, error, now = Date.now()) {
      q.dead.run(error, now, orderId);
    },

    getOrder(orderId) {
      return q.get.get(String(orderId)) ?? null;
    },

    /** Orders that should have a shipment by now but don't. */
    findUnconfirmed({ now = Date.now(), graceMs = 60000 } = {}) {
      return q.unconfirmed.all({ now, staleBefore: now - graceMs });
    },

    /** Put an order back on the queue. resetAttempts=true gives it a fresh retry budget. */
    requeue(orderId, { now = Date.now(), resetAttempts = false } = {}) {
      return q.requeue.run(now, resetAttempts ? 1 : 0, now, String(orderId)).changes;
    },

    stats() {
      return Object.fromEntries(q.countByStatus.all().map((r) => [r.status, r.n]));
    },
    allOrders() {
      return q.all.all();
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openDb };

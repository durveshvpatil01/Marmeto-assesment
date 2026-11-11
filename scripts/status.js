'use strict';

// npm run status   -> counts by status, plus every order that is not shipped
const config = require('../src/config');
const { openDb } = require('../src/db');

const repo = openDb(config.dbPath);
console.log('orders by status:', repo.stats());
const notShipped = repo.allOrders().filter((o) => o.status !== 'shipped');
if (notShipped.length) {
  console.table(
    notShipped.map((o) => ({
      order: o.order_id,
      status: o.status,
      attempts: o.attempts,
      next_attempt: new Date(o.next_attempt_at).toISOString(),
      last_error: o.last_error,
    }))
  );
}
repo.close();

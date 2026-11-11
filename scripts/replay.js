'use strict';

// npm run replay -- <orderId> [<orderId>...]   replay specific dead orders
// npm run replay -- --all-dead                 replay every dead order
// Safe to run any time: the worker checks the courier before creating.
const config = require('../src/config');
const { openDb } = require('../src/db');

const repo = openDb(config.dbPath);
const args = process.argv.slice(2);
const ids = args.includes('--all-dead')
  ? repo.allOrders().filter((o) => o.status === 'dead').map((o) => o.order_id)
  : args.filter((a) => !a.startsWith('--'));

if (ids.length === 0) {
  console.log('usage: npm run replay -- <orderId...> | --all-dead');
  process.exit(1);
}
for (const id of ids) {
  const changed = repo.requeue(id, { resetAttempts: true });
  console.log(`${id}: ${changed ? 'requeued' : 'not requeued (unknown, shipped, or currently processing)'}`);
}
repo.close();

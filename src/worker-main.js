'use strict';

// Run the worker on its own (e.g. to scale workers separately from the HTTP server).
// Safe alongside src/index.js: claims are atomic and the DB is shared via WAL.
const config = require('./config');
const { openDb } = require('./db');
const { createCourierClient } = require('./courier');
const { createWorker } = require('./worker');

const repo = openDb(config.dbPath);
const worker = createWorker({
  repo,
  courier: createCourierClient({ baseUrl: config.courierUrl, timeoutMs: config.courierTimeoutMs }),
  config,
  concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
});
worker.start();
console.log('[worker] started');

const stop = async () => {
  await worker.stop();
  repo.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

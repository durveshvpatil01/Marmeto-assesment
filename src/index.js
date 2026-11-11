'use strict';

// HTTP server + background worker + periodic reconcile, in one process.
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createCourierClient } = require('./courier');
const { createWorker } = require('./worker');
const { reconcile } = require('./reconcile');

const repo = openDb(config.dbPath);
const courier = createCourierClient({ baseUrl: config.courierUrl, timeoutMs: config.courierTimeoutMs });
const worker = createWorker({
  repo,
  courier,
  config,
  concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
});
const server = createApp({ repo, secret: config.webhookSecret, onEnqueued: () => worker.wake() });

server.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}  courier=${config.courierUrl}  db=${config.dbPath}`);
  worker.start();
});

const reconcileEveryMs = Number(process.env.RECONCILE_INTERVAL_MS || 60000);
const reconcileTimer = setInterval(() => {
  reconcile({ repo, courier })
    .then((s) => s.checked && console.log('[reconcile] scheduled run', s))
    .catch((e) => console.error('[reconcile] failed', e));
}, reconcileEveryMs);

async function shutdown(signal) {
  console.log(`[server] ${signal}: shutting down`);
  clearInterval(reconcileTimer);
  server.close();
  await worker.stop(); // in-flight jobs finish; anything interrupted is reclaimed via its lease
  repo.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

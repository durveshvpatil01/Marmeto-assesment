'use strict';

// npm run reconcile                 -> one pass (orders stuck > 60s)
// npm run reconcile -- --grace 0    -> include everything not yet shipped
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createCourierClient } = require('../src/courier');
const { reconcile } = require('../src/reconcile');

const i = process.argv.indexOf('--grace');
const graceMs = i > -1 ? Number(process.argv[i + 1]) * 1000 : 60000;

(async () => {
  const repo = openDb(config.dbPath);
  const courier = createCourierClient({ baseUrl: config.courierUrl, timeoutMs: config.courierTimeoutMs });
  const summary = await reconcile({ repo, courier, graceMs });
  console.log('[reconcile] done', summary);
  repo.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

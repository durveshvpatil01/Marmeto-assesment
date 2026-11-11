'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the project has zero dependencies.
// Real env vars win over the file.
function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const int = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number.parseInt(v, 10);
};

module.exports = {
  port: int('PORT', 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || 'dev-secret-change-me',
  courierUrl: process.env.COURIER_URL || 'http://localhost:4000',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  courierTimeoutMs: int('COURIER_TIMEOUT_MS', 3000),
  maxAttempts: int('MAX_ATTEMPTS', 6),
  backoffBaseMs: int('BACKOFF_BASE_MS', 500),
  backoffMaxMs: int('BACKOFF_MAX_MS', 30000),
  leaseMs: int('LEASE_MS', 30000),
  pollMs: int('POLL_MS', 250),
};

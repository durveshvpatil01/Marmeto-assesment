'use strict';

/**
 * Mock courier API. Deliberately unreliable and NOT idempotent.
 *
 *   POST /shipments { reference, address, items }  -> 201 { shipmentId, reference }
 *     ~20% -> 500
 *     ~10% -> 429 with Retry-After: 2
 *     ~10% -> creates the shipment, then hangs (default 10s) before answering
 *   GET  /shipments?reference=<orderId>           -> 200 [shipments...]
 *
 * Improvements over the brief (for testing/observability):
 *   - Rates and hang time are configurable (env or createMockCourier options).
 *   - POST /__control/script { outcomes: ["hang","500","429","ok"] } forces the next
 *     outcomes in order, so tests are deterministic.
 *   - GET /__control/stats shows how many shipments exist per reference
 *     (the number we care about: must never be > 1).
 *   - POST /__control/reset clears everything.
 *   - commitDelayMs (option or MOCK_COMMIT_DELAY_MS): a created shipment only becomes
 *     visible to GET after this delay, and the POST only answers then. This models a
 *     courier that commits asynchronously (the "GET right after a timeout shows
 *     nothing yet" case). Default 0.
 */

const http = require('node:http');
const crypto = require('node:crypto');

function createMockCourier(opts = {}) {
  const rates = {
    fail500: opts.fail500 ?? Number(process.env.MOCK_FAIL_500 ?? 0.2),
    fail429: opts.fail429 ?? Number(process.env.MOCK_FAIL_429 ?? 0.1),
    hang: opts.hang ?? Number(process.env.MOCK_HANG ?? 0.1),
  };
  const hangMs = opts.hangMs ?? Number(process.env.MOCK_HANG_MS ?? 10000);
  const retryAfterSec = opts.retryAfterSec ?? 2;
  const commitDelayMs = opts.commitDelayMs ?? Number(process.env.MOCK_COMMIT_DELAY_MS ?? 0);

  const shipments = new Map(); // reference -> [{ shipmentId, reference, address, items, createdAt }]
  let script = [];
  const timers = new Set();

  function pickOutcome() {
    if (script.length) return script.shift();
    const r = Math.random();
    if (r < rates.fail500) return '500';
    if (r < rates.fail500 + rates.fail429) return '429';
    if (r < rates.fail500 + rates.fail429 + rates.hang) return 'hang';
    return 'ok';
  }

  function create(body) {
    const s = {
      shipmentId: 'shp_' + crypto.randomUUID(),
      reference: String(body.reference),
      address: body.address ?? null,
      items: body.items ?? [],
      createdAt: new Date().toISOString(),
      visibleAt: Date.now() + commitDelayMs,
    };
    if (!shipments.has(s.reference)) shipments.set(s.reference, []);
    shipments.get(s.reference).push(s);
    return s;
  }

  const send = (res, status, obj, headers = {}) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };

  const readJson = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve(null);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/shipments') {
      const ref = url.searchParams.get('reference');
      if (!ref) return send(res, 400, { error: 'reference is required' });
      const now = Date.now();
      return send(res, 200, (shipments.get(ref) ?? []).filter((s) => (s.visibleAt ?? 0) <= now));
    }

    if (req.method === 'POST' && url.pathname === '/shipments') {
      const body = await readJson(req);
      if (!body || body.reference === undefined || body.reference === null || body.reference === '') {
        return send(res, 400, { error: 'reference is required' });
      }
      const outcome = pickOutcome();
      if (outcome === '500') return send(res, 500, { error: 'internal error' });
      if (outcome === '429') {
        return send(res, 429, { error: 'rate limited' }, { 'retry-after': String(retryAfterSec) });
      }
      const s = create(body);
      if (outcome === 'hang') {
        const t = setTimeout(() => {
          timers.delete(t);
          send(res, 201, { shipmentId: s.shipmentId, reference: s.reference });
        }, hangMs);
        timers.add(t);
        return;
      }
      if (commitDelayMs > 0) {
        const t = setTimeout(() => {
          timers.delete(t);
          send(res, 201, { shipmentId: s.shipmentId, reference: s.reference });
        }, commitDelayMs);
        timers.add(t);
        return;
      }
      return send(res, 201, { shipmentId: s.shipmentId, reference: s.reference });
    }

    if (req.method === 'POST' && url.pathname === '/__control/script') {
      const body = await readJson(req);
      script = Array.isArray(body?.outcomes) ? [...body.outcomes] : [];
      return send(res, 200, { script });
    }
    if (req.method === 'POST' && url.pathname === '/__control/reset') {
      shipments.clear();
      script = [];
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/__control/stats') {
      const perReference = Object.fromEntries([...shipments].map(([k, v]) => [k, v.length]));
      const duplicates = Object.entries(perReference).filter(([, n]) => n > 1).map(([k]) => k);
      return send(res, 200, { references: shipments.size, perReference, duplicates });
    }

    send(res, 404, { error: 'not found' });
  });

  return {
    server,
    shipments,
    setScript: (outcomes) => { script = [...outcomes]; },
    listen: (port = 0) =>
      new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

module.exports = { createMockCourier };

if (require.main === module) {
  const port = Number(process.env.COURIER_PORT || 4000);
  const courier = createMockCourier();
  courier.listen(port).then((p) => console.log(`[mock-courier] listening on http://localhost:${p}`));
}

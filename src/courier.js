'use strict';

/**
 * Thin client for the courier API. Its only job is to turn HTTP outcomes into
 * a small set of error kinds the worker can make decisions on.
 */
class CourierError extends Error {
  constructor(kind, message, { status, retryAfterMs, retryable } = {}) {
    super(message);
    this.name = 'CourierError';
    this.kind = kind; // rate_limited | server_error | timeout | network | client_error | bad_response
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable ?? kind !== 'client_error';
  }
}

/** Retry-After can be delta-seconds or an HTTP-date. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function createCourierClient({ baseUrl, timeoutMs = 3000, fetchImpl = fetch }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        // Ambiguous: the courier may have done the work. Callers must check before re-POSTing.
        throw new CourierError('timeout', `${method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw new CourierError('network', `${method} ${path} failed: ${err.cause?.code || err.message}`);
    }

    if (res.status === 429) {
      throw new CourierError('rate_limited', `${method} ${path} -> 429`, {
        status: 429,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (res.status >= 500) throw new CourierError('server_error', `${method} ${path} -> ${res.status}`, { status: res.status });
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new CourierError('client_error', `${method} ${path} -> ${res.status} ${text}`.trim(), { status: res.status });
    }
    try {
      return await res.json();
    } catch {
      throw new CourierError('bad_response', `${method} ${path} -> ${res.status} with non-JSON body`);
    }
  }

  return {
    async findByReference(reference) {
      const list = await call('GET', `/shipments?reference=${encodeURIComponent(reference)}`);
      if (!Array.isArray(list)) throw new CourierError('bad_response', 'GET /shipments did not return a list');
      return list;
    },
    async createShipment({ reference, address, items }) {
      const s = await call('POST', '/shipments', { reference, address, items });
      if (!s?.shipmentId) throw new CourierError('bad_response', 'POST /shipments returned no shipmentId');
      return s;
    },
  };
}

module.exports = { createCourierClient, CourierError, parseRetryAfter };

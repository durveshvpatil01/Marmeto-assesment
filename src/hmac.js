'use strict';

const crypto = require('node:crypto');

function sign(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

/**
 * Verify X-Shop-Hmac-Sha256 = base64(HMAC-SHA256(rawBody, secret)).
 * Must be computed over the RAW bytes we received, not re-serialised JSON
 * (key order / whitespace / unicode escaping would change the digest).
 */
function verifySignature(rawBody, header, secret) {
  if (typeof header !== 'string' || header.length === 0 || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(header.trim(), 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch; length of a SHA-256 digest is not secret.
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

module.exports = { sign, verifySignature };

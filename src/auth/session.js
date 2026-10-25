'use strict';
/**
 * src/auth/session.js
 *
 * Sign-in with an Arc wallet (EIP-4361 style message, no gas, no funds access).
 *   1. POST /api/auth/nonce  -> server stores the exact message to sign (bound to a one-time nonce)
 *   2. wallet signs it       -> POST /api/auth/login verifies the signature, then sets a signed httpOnly cookie
 * Sessions are stateless HMAC tokens (no extra dependency): { sub: address, iat, exp }.
 */

const crypto = require('crypto');
const { verifyMessage } = require('viem');
const config = require('../config');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const isAddress = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);

function secret() {
  if (config.auth.sessionSecret) return config.auth.sessionSecret;
  if (config.env === 'production' || config.arc.isMainnet) throw new Error('SESSION_SECRET is required');
  return 'dev-only-insecure-session-secret'; // development convenience only; validate() blocks this in production
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function issueToken(address, now = Date.now()) {
  const payload = b64u(JSON.stringify({ sub: address.toLowerCase(), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + config.auth.sessionTtlSeconds }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(sig || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!isAddress(data.sub) || data.exp * 1000 < now) return null;
    return { address: data.sub, expiresAt: data.exp * 1000 };
  } catch { return null; }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function sessionCookie(token, { secure, maxAge }) {
  return `${config.auth.cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function userFromRequest(request) {
  return readToken(parseCookies(request.headers.cookie)[config.auth.cookieName]);
}

/** Fastify preHandler: 401 unless a valid session cookie is present. */
async function requireAuth(request, reply) {
  const user = userFromRequest(request);
  if (!user) return reply.code(401).send({ error: true, code: 'UNAUTHENTICATED', message: 'Sign in with your wallet to continue' });
  request.user = user;
}

function buildMessage({ domain, uri, address, chainId, nonce, issuedAt, expiresAt }) {
  return `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in to Chronos. This does not cost gas and does not give access to your funds.

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expiresAt}`;
}

async function createChallenge(db, { address, domain, uri }) {
  if (!isAddress(address)) throw Object.assign(new Error('Invalid address'), { statusCode: 400 });
  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now + config.auth.nonceTtlSeconds * 1000);
  const message = buildMessage({ domain, uri, address, chainId: config.arc.chainId, nonce, issuedAt: new Date(now).toISOString(), expiresAt: expiresAt.toISOString() });
  await db.collection('authNonces').insertOne({ nonce, address: address.toLowerCase(), message, expiresAt });
  return { message, nonce };
}

/** Verifies the signature against the stored challenge. The nonce is consumed (one use). Returns the address. */
async function verifyChallenge(db, { address, signature, nonce }) {
  if (!isAddress(address) || typeof signature !== 'string' || typeof nonce !== 'string') throw Object.assign(new Error('Invalid request'), { statusCode: 400 });
  const row = await db.collection('authNonces').findOneAndDelete({ nonce, address: address.toLowerCase() });
  const doc = row && row.message ? row : row?.value; // driver v5 returns {value}, v6 returns the doc
  if (!doc || new Date(doc.expiresAt).getTime() < Date.now()) throw Object.assign(new Error('Sign-in request expired. Try again'), { statusCode: 401 });
  let ok = false;
  try { ok = await verifyMessage({ address, message: doc.message, signature }); } catch { ok = false; }
  if (!ok) throw Object.assign(new Error('Signature did not match this wallet'), { statusCode: 401 });
  return address.toLowerCase();
}

module.exports = { issueToken, readToken, parseCookies, sessionCookie, userFromRequest, requireAuth, createChallenge, verifyChallenge, buildMessage, isAddress };

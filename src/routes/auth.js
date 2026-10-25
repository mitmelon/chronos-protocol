'use strict';

const config = require('../config');
const { db } = require('../db/client');
const session = require('../auth/session');

function originOf(request) {
  // request.protocol / request.host honour X-Forwarded-* only when the server was created with trustProxy.
  const proto = request.protocol || 'http';
  const host = request.host || request.headers.host;
  return { domain: host, uri: `${proto}://${host}`, secure: proto === 'https' };
}

/** State-changing requests must come from our own origin (defence in depth next to SameSite=Lax). */
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === (request.host || request.headers.host); } catch { return false; }
}

module.exports = async function authRoutes(app) {
  // Public chain description for the browser: which network this deployment is on (testnet or mainnet).
  app.get('/api/chain', async () => ({ ...config.arc.publicChain, contractAddress: config.arc.factoryAddress, feeBps: config.protocol.feeBps }));

  app.post('/api/auth/nonce', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: true, code: 'BAD_ORIGIN', message: 'Cross-origin request blocked' });
    try {
      const { domain, uri } = originOf(request);
      const { message, nonce } = await session.createChallenge(db(), { address: request.body?.address, domain, uri });
      return { message, nonce };
    } catch (err) { return reply.code(err.statusCode || 500).send({ error: true, message: err.message }); }
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: true, code: 'BAD_ORIGIN', message: 'Cross-origin request blocked' });
    try {
      const { address, signature, nonce } = request.body || {};
      const verified = await session.verifyChallenge(db(), { address, signature, nonce });
      const token = session.issueToken(verified);
      reply.header('Set-Cookie', session.sessionCookie(token, { secure: originOf(request).secure, maxAge: config.auth.sessionTtlSeconds }));
      return { authenticated: true, address: verified };
    } catch (err) { return reply.code(err.statusCode || 500).send({ error: true, message: err.message }); }
  });

  app.get('/api/auth/me', async (request) => {
    const user = session.userFromRequest(request);
    return user ? { authenticated: true, address: user.address, expiresAt: user.expiresAt } : { authenticated: false };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', session.sessionCookie('', { secure: originOf(request).secure, maxAge: 0 }));
    return { authenticated: false };
  });
};

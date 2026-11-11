const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db/database');
const { constantEqual, hashToken, readSessionToken, safeReturnTo } = require('./security');

async function createApp({ config = loadConfig(), db: suppliedDb } = {}) {
  const db = suppliedDb || await openDatabase({ filename: config.databasePath, password: config.adminPassword });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (config.secureCookie) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));

  const cookieOptions = {
    httpOnly: true, secure: config.secureCookie, sameSite: 'lax', path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
  const clearCookie = (res) => res.clearCookie(config.cookieName, cookieOptions);
  const sessionFor = async (req) => {
    const token = readSessionToken(req, config.cookieName);
    if (!token) return null;
    return await db.get('SELECT * FROM gateway_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?', [hashToken(token), Date.now()]) || null;
  };
  const requireSession = async (req, res, next) => {
    req.session = await sessionFor(req);
    if (!req.session) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    next();
  };
  const requireSameOrigin = (req, res, next) => {
    if (!config.allowedOrigins.has(req.get('Origin')) || req.get('X-Gatekeeper-Request') !== '1' || !req.is('application/json')) {
      return res.status(403).json({ error: 'This action must come from the Gatekeeper page.' });
    }
    next();
  };
  const requireCsrf = (req, res, next) => {
    if (!constantEqual(req.get('X-CSRF-Token'), req.session.csrf_token)) {
      return res.status(403).json({ error: 'The page has expired. Refresh and try again.' });
    }
    next();
  };

  app.get('/health', async (req, res) => {
    await db.get('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.get('/api/v1/session', async (req, res) => {
    const session = await sessionFor(req);
    if (!session) return res.json({ authenticated: false });
    res.json({ authenticated: true, username: config.username, sessionId: session.id,
      expiresAt: new Date(session.expires_at).toISOString(), csrfToken: session.csrf_token });
  });

  app.post('/api/v1/login', requireSameOrigin, async (req, res) => {
    const redirectTo = safeReturnTo(req.body?.returnTo, config);
    if (redirectTo === null) return res.status(400).json({ error: 'That return address is not a registered application.' });
    const password = req.body?.password;
    if (typeof password !== 'string' || !password.length || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter a valid password (up to 72 UTF-8 bytes).' });
    }
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    await db.run('DELETE FROM login_attempts WHERE attempted_at <= ?', [now - config.loginWindowMs]);
    const prior = await db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN ip_address = ? THEN 1 ELSE 0 END) AS per_ip FROM login_attempts', [ip]);
    if (prior.per_ip >= config.loginMaxAttempts || prior.total >= config.loginGlobalMaxAttempts) {
      res.set('Retry-After', String(Math.ceil(config.loginWindowMs / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    // Record before checking the limit so concurrent attempts cannot bypass it.
    const attempt = await db.run('INSERT INTO login_attempts (ip_address, attempted_at) VALUES (?, ?)', [ip, now]);
    const counts = await db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN ip_address = ? THEN 1 ELSE 0 END) AS per_ip FROM login_attempts', [ip]);
    if (counts.per_ip > config.loginMaxAttempts || counts.total > config.loginGlobalMaxAttempts) {
      res.set('Retry-After', String(Math.ceil(config.loginWindowMs / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    const admin = await db.get('SELECT password_hash FROM admin ORDER BY id LIMIT 1');
    if (!admin || !await bcrypt.compare(password, admin.password_hash)) return res.status(401).json({ error: 'Incorrect password.' });
    await db.run('DELETE FROM login_attempts WHERE id = ?', [attempt.lastID]);
    // Rotate a pre-existing login instead of accepting a caller-supplied session identifier.
    const existing = await sessionFor(req);
    if (existing) await db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE id = ?', [now, existing.id]);
    const token = crypto.randomBytes(32).toString('base64url');
    const inserted = await db.run(`INSERT INTO gateway_sessions
      (id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_address, user_agent)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin WHERE password_hash = ?)`,
    [crypto.randomUUID(), hashToken(token), crypto.randomBytes(32).toString('base64url'), now,
      now + config.sessionTtlMs, now, ip, (req.get('user-agent') || 'Unknown browser').slice(0, 512), admin.password_hash]);
    if (!inserted.changes) return res.status(401).json({ error: 'The password has changed. Please sign in again.' });
    await db.run('DELETE FROM gateway_sessions WHERE expires_at < ? OR revoked_at < ?', [now - 30 * 86400000, now - 30 * 86400000]);
    res.cookie(config.cookieName, token, { ...cookieOptions, maxAge: config.sessionTtlMs });
    res.json({ redirectTo });
  });

  app.get('/api/v1/apps', requireSession, (req, res) => res.json({ apps: config.apps }));

  app.get('/api/v1/sessions', requireSession, async (req, res) => {
    const rows = await db.all('SELECT * FROM gateway_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', [Date.now()]);
    res.json({ sessions: rows.map((session) => ({
      id: session.id, current: session.id === req.session.id,
      createdAt: new Date(session.created_at).toISOString(), expiresAt: new Date(session.expires_at).toISOString(),
      lastSeenAt: new Date(session.last_seen_at).toISOString(), ipAddress: session.ip_address, userAgent: session.user_agent,
    })) });
  });

  const mutationGuards = [requireSameOrigin, requireSession, requireCsrf];
  app.post('/api/v1/logout', ...mutationGuards, async (req, res) => {
    await db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE id = ?', [Date.now(), req.session.id]);
    clearCookie(res);
    res.sendStatus(204);
  });
  app.post('/api/v1/sessions/revoke-others', ...mutationGuards, async (req, res) => {
    await db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE id <> ? AND revoked_at IS NULL', [Date.now(), req.session.id]);
    res.sendStatus(204);
  });
  app.post('/api/v1/sessions/:id/revoke', ...mutationGuards, async (req, res) => {
    const result = await db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'Session not found.' });
    if (req.params.id === req.session.id) clearCookie(res);
    res.sendStatus(204);
  });

  app.get('/auth/verify', async (req, res) => {
    if (!constantEqual(req.get('X-Gatekeeper-Proxy-Key'), config.proxySecret)) return res.status(403).json({ error: 'Trusted proxy required.' });
    const host = req.get('X-Forwarded-Host') || '';
    const proto = req.get('X-Forwarded-Proto');
    const uri = req.get('X-Forwarded-Uri') || '';
    const method = req.get('X-Forwarded-Method') || '';
    if (!['http', 'https'].includes(proto) || !host || /[\s,/@\\?#]/.test(host) ||
        !/^[A-Z]{3,12}$/.test(method) || !uri.startsWith('/') || uri.startsWith('//')) {
      return res.status(403).json({ error: 'Invalid proxy metadata.' });
    }
    let target;
    try {
      const forwardedOrigin = new URL(`${proto}://${host}`).origin;
      if (!config.apps.some((item) => item.url === forwardedOrigin)) throw new Error('Unregistered application.');
      target = safeReturnTo(`${forwardedOrigin}${uri}`, config);
    } catch { target = null; }
    if (!target) return res.status(403).json({ error: 'Unregistered application or invalid request URL.' });
    const session = await sessionFor(req);
    if (!session) {
      if (['GET', 'HEAD'].includes(method) && (req.get('Accept') || '').includes('text/html')) {
        return res.redirect(302, `${config.gatewayUrl}/login?returnTo=${encodeURIComponent(target)}`);
      }
      return res.status(401).json({ error: 'Sign in through Gatekeeper before accessing this application.' });
    }
    await db.run('UPDATE gateway_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?', [Date.now(), session.id, Date.now() - 60000]);
    return res.sendStatus(204);
  });

  // Explicitly retire the approval/JWT routes. Never let SPA fallback mask these endpoints.
  app.use(['/api', '/auth', '/admin', '/socket.io'], (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use(express.static(config.frontendPath, { index: false, dotfiles: 'deny' }));
  app.get(['/', '/login'], (req, res) => {
    const index = path.join(config.frontendPath, 'index.html');
    if (!fs.existsSync(index)) return res.status(503).type('text').send('Build the frontend first: npm run build (from the repository root).');
    res.sendFile(index);
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && 'body' in error ? 400 : 503;
    if (status === 503) console.error('Gatekeeper request failed:', error.code || error.name);
    res.status(status).json({ error: status === 413 ? 'Request is too large.' : status === 400 ? 'Invalid JSON request.' : 'Gatekeeper is temporarily unavailable. Access is blocked.' });
  });
  return { app, db, close: () => db.close() };
}

module.exports = { createApp };

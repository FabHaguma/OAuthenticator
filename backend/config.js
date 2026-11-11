const path = require('node:path');
const { isIP } = require('node:net');

function origin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) origin without a path, credentials, query, or fragment.`);
  }
  return url;
}

function number(value, fallback, label, max) {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`${label} is out of range.`);
  return result;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters and at most 72 UTF-8 bytes.');
  }
}

function loadConfig(env = process.env) {
  const port = number(env.PORT, 4000, 'PORT', 65535);
  const gateway = origin(env.GATEKEEPER_URL || `http://localhost:${port}`, 'GATEKEEPER_URL');
  const production = env.NODE_ENV === 'production';
  const local = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if ((production || !local(gateway.hostname)) && gateway.protocol !== 'https:') {
    throw new Error('GATEKEEPER_URL must use HTTPS outside local development.');
  }
  const proxySecret = env.PROXY_AUTH_SECRET || '';
  if (proxySecret.length < 32 || /^replace[-_]/i.test(proxySecret) || /[\s\x00-\x1f\x7f]/.test(proxySecret)) {
    throw new Error('Set PROXY_AUTH_SECRET to a random value of at least 32 characters (no whitespace).');
  }
  const adminPassword = env.ADMIN_PASSWORD || '';
  if (/^replace[-_]/i.test(adminPassword)) throw new Error('Replace the ADMIN_PASSWORD example with your own password.');
  if (adminPassword) validatePassword(adminPassword);
  let apps;
  try { apps = JSON.parse(env.PROTECTED_APPS || '[]'); } catch { throw new Error('PROTECTED_APPS must be a JSON array.'); }
  if (!Array.isArray(apps)) throw new Error('PROTECTED_APPS must be a JSON array.');
  const ids = new Set();
  const origins = new Set();
  apps = apps.map((app) => {
    if (!app || typeof app.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(app.id) ||
        typeof app.name !== 'string' || !app.name.trim() || app.name.length > 100 || typeof app.url !== 'string') {
      throw new Error('Each protected app needs a unique id, a name, and an origin URL.');
    }
    const url = origin(app.url, `PROTECTED_APPS ${app.id}`);
    if (url.origin === gateway.origin || ids.has(app.id) || origins.has(url.origin)) {
      throw new Error('Protected app ids and origins must be unique and distinct from GATEKEEPER_URL.');
    }
    if ((production || !local(url.hostname)) && url.protocol !== 'https:') throw new Error('Protected apps must use HTTPS outside local development.');
    ids.add(app.id);
    origins.add(url.origin);
    return { id: app.id, name: app.name.trim(), url: url.origin };
  });
  const cookieDomain = (env.COOKIE_DOMAIN || '').toLowerCase().replace(/^\./, '');
  if (cookieDomain) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(cookieDomain) || isIP(cookieDomain)) {
      throw new Error('COOKIE_DOMAIN must be a parent domain you own, e.g. example.com.');
    }
    for (const url of [gateway, ...apps.map((app) => new URL(app.url))]) {
      if (url.hostname !== cookieDomain && !url.hostname.endsWith(`.${cookieDomain}`)) {
        throw new Error('The login service and every protected app must be inside COOKIE_DOMAIN.');
      }
    }
  } else if (apps.some((app) => new URL(app.url).hostname !== gateway.hostname)) {
    throw new Error('Set COOKIE_DOMAIN to share a login across protected subdomains.');
  }
  let devOrigin = '';
  if (env.DEV_UI_ORIGIN) {
    const dev = origin(env.DEV_UI_ORIGIN, 'DEV_UI_ORIGIN');
    if (production || !local(dev.hostname)) throw new Error('DEV_UI_ORIGIN is only supported on localhost outside production.');
    devOrigin = dev.origin;
  }
  const trustProxy = env.TRUST_PROXY === 'false' ? false : (env.TRUST_PROXY || 'loopback');
  if (trustProxy !== false && /^(true|\d+|0\.0\.0\.0\/0|::\/0)$/i.test(trustProxy)) {
    throw new Error('TRUST_PROXY must identify specific trusted proxy addresses, not every client.');
  }
  return {
    port, host: env.HOST || '127.0.0.1', production,
    gatewayUrl: gateway.origin, allowedOrigins: new Set([gateway.origin, ...(devOrigin ? [devOrigin] : [])]),
    apps, proxySecret, cookieDomain: cookieDomain || undefined, secureCookie: gateway.protocol === 'https:',
    cookieName: 'gatekeeper_session', trustProxy,
    username: (env.GATEKEEPER_USERNAME || 'owner').slice(0, 100), adminPassword,
    databasePath: env.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(__dirname, env.DATABASE_PATH || 'database.sqlite'),
    sessionTtlMs: number(env.SESSION_TTL_HOURS, 168, 'SESSION_TTL_HOURS', 2160) * 3600000,
    loginWindowMs: 15 * 60000,
    loginMaxAttempts: number(env.LOGIN_MAX_ATTEMPTS, 5, 'LOGIN_MAX_ATTEMPTS', 100),
    loginGlobalMaxAttempts: number(env.LOGIN_GLOBAL_MAX_ATTEMPTS, 30, 'LOGIN_GLOBAL_MAX_ATTEMPTS', 1000),
    frontendPath: path.resolve(__dirname, '../frontend/dist'),
  };
}

module.exports = { loadConfig, validatePassword };

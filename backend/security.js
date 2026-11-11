const crypto = require('node:crypto');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function constantEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(actual).digest(), crypto.createHash('sha256').update(expected).digest());
}

function readSessionToken(req, name) {
  const matches = (req.headers.cookie || '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function safeReturnTo(value, config) {
  if (value === undefined || value === null || value === '') return '/';
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    // Reject encoded controls/backslashes too; URL parsers and upstreams can disagree about them.
    if (/[\\\x00-\x1f\x7f]/.test(decodeURIComponent(value))) return null;
    if (value.startsWith('//')) return null;
    const url = new URL(value, config.gatewayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin === config.gatewayUrl) {
      return url.pathname === '/' ? `/${url.search}${url.hash}` : null;
    }
    return config.apps.some((app) => app.url === url.origin) ? url.href : null;
  } catch { return null; }
}

module.exports = { hashToken, constantEqual, readSessionToken, safeReturnTo };

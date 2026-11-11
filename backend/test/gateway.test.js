const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const { createApp } = require('../app');
const { loadConfig } = require('../config');

const GATEWAY_ORIGIN = 'http://localhost:4000';
const APP_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-fictional-test-password-42';
const PROXY_KEY = 'test-only-proxy-secret-that-is-long-enough-42';
const openHarnesses = [];
const temporaryDirectories = [];

async function temporaryDatabase() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gatekeeper-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'test.sqlite');
}

async function harness(overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    GATEKEEPER_URL: GATEWAY_ORIGIN,
    ADMIN_PASSWORD: PASSWORD,
    GATEKEEPER_USERNAME: 'Fabrice Test',
    DATABASE_PATH: ':memory:',
    LOGIN_MAX_ATTEMPTS: '25',
    PROXY_AUTH_SECRET: PROXY_KEY,
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Test Notes', url: APP_ORIGIN }]),
    ...overrides,
  });
  const instance = await createApp({ config });
  const server = http.createServer(instance.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${address}${path}`, { redirect: 'manual', ...options });
  const mutationHeaders = (cookie, csrfToken) => ({
    Origin: new URL(overrides.GATEKEEPER_URL || GATEWAY_ORIGIN).origin,
    'Content-Type': 'application/json',
    'X-Gatekeeper-Request': '1',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  });
  const login = async (body = { password: PASSWORD }) => {
    const response = await request('/api/v1/login', {
      method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie, 'login must set a session cookie');
    const cookie = setCookie.split(';')[0];
    const sessionResponse = await request('/api/v1/session', { headers: { Cookie: cookie } });
    assert.equal(sessionResponse.status, 200);
    return { cookie, setCookie, session: await sessionResponse.json(), response };
  };
  const verifyHeaders = (cookie, extra = {}) => ({
    'X-Gatekeeper-Proxy-Key': PROXY_KEY,
    'X-Forwarded-Proto': 'http',
    'X-Forwarded-Host': 'localhost:3000',
    'X-Forwarded-Uri': '/private/page?tab=one',
    'X-Forwarded-Method': 'GET',
    Accept: 'text/html',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  });
  const result = { ...instance, config, request, login, mutationHeaders, verifyHeaders };
  openHarnesses.push({ server, close: instance.close });
  return result;
}

afterEach(async () => {
  for (const { server, close } of openHarnesses.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    for (const filename of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
      await fs.unlink(path.join(directory, filename)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await fs.rmdir(directory);
  }
});

test('anonymous sessions cannot read app or device data', async () => {
  const app = await harness();
  const session = await app.request('/api/v1/session');
  assert.equal(session.status, 200);
  assert.equal((await session.json()).authenticated, false);
  for (const path of ['/api/v1/apps', '/api/v1/sessions']) {
    assert.equal((await app.request(path)).status, 401);
  }
});

test('login establishes an HttpOnly cookie and exposes only the session metadata needed by the UI', async () => {
  const app = await harness();
  const { setCookie, session, cookie } = await app.login();
  assert.match(cookie, /^gatekeeper_session=[A-Za-z0-9_-]+$/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.doesNotMatch(setCookie, /; Secure/i, 'localhost HTTP mode must work without TLS');
  assert.equal(session.authenticated, true);
  assert.equal(session.username, 'Fabrice Test');
  assert.equal(typeof session.csrfToken, 'string');
  assert.ok(session.csrfToken.length >= 32);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  const apps = await app.request('/api/v1/apps', { headers: { Cookie: cookie } });
  assert.deepEqual((await apps.json()).apps, [{ id: 'notes', name: 'Test Notes', url: APP_ORIGIN }]);
});

test('production session cookies require HTTPS and cover the configured trusted parent domain', async () => {
  const app = await harness({
    NODE_ENV: 'production', GATEKEEPER_URL: 'https://login.example.com', COOKIE_DOMAIN: 'example.com',
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'https://notes.example.com' }]),
  });
  const { setCookie } = await app.login();
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; Domain=example\.com/i);
});

test('database stores a digest of the bearer cookie rather than its raw value', async () => {
  const app = await harness();
  const { cookie, session } = await app.login();
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const row = await app.db.get('SELECT * FROM gateway_sessions WHERE id = ?', [session.sessionId]);
  assert.ok(row);
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(token), false);
});

test('wrong and malformed passwords never establish sessions', async () => {
  const app = await harness();
  for (const body of [{ password: 'wrong' }, {}, { password: ['not-a-string'] }]) {
    const response = await app.request('/api/v1/login', {
      method: 'POST', headers: app.mutationHeaders(), body: JSON.stringify(body),
    });
    assert.ok([400, 401].includes(response.status));
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const rows = await app.db.all('SELECT * FROM gateway_sessions');
  assert.equal(rows.length, 0);
});

test('repeated password failures throttle the source IP before checking another password', async () => {
  const app = await harness({ LOGIN_MAX_ATTEMPTS: '2' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request('/api/v1/login', {
      method: 'POST', headers: app.mutationHeaders(), body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await app.request('/api/v1/login', {
    method: 'POST', headers: app.mutationHeaders(), body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(blocked.headers.get('set-cookie'), null);
});

test('global failure throttling also blocks attempts spread over different source addresses', async () => {
  const app = await harness({ LOGIN_GLOBAL_MAX_ATTEMPTS: '2' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request('/api/v1/login', {
      method: 'POST', headers: { ...app.mutationHeaders(), 'X-Forwarded-For': `192.0.2.${attempt + 1}` },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await app.request('/api/v1/login', {
    method: 'POST', headers: { ...app.mutationHeaders(), 'X-Forwarded-For': '192.0.2.100' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(blocked.status, 429);
});

test('concurrent login attempts cannot exceed the configured attempt budget', async () => {
  const app = await harness({ LOGIN_MAX_ATTEMPTS: '2' });
  const responses = await Promise.all(Array.from({ length: 6 }, () => app.request('/api/v1/login', {
    method: 'POST', headers: app.mutationHeaders(), body: JSON.stringify({ password: PASSWORD }),
  })));
  assert.ok(responses.every(response => [200, 429].includes(response.status)));
  assert.ok(responses.filter(response => response.status === 200).length <= 2);
});

test('a password reset during password verification cannot create a session with the previous password', async () => {
  const app = await harness();
  const originalCompare = bcrypt.compare;
  let releaseCompare;
  let compareStarted;
  const started = new Promise(resolve => { compareStarted = resolve; });
  const release = new Promise(resolve => { releaseCompare = resolve; });
  bcrypt.compare = async (...args) => {
    const valid = await originalCompare(...args);
    compareStarted();
    await release;
    return valid;
  };
  try {
    const pending = app.request('/api/v1/login', {
      method: 'POST', headers: app.mutationHeaders(), body: JSON.stringify({ password: PASSWORD }),
    });
    await started;
    await app.db.run('UPDATE admin SET password_hash = ?', [await bcrypt.hash('a-new-fictional-password-42', 4)]);
    await app.db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE revoked_at IS NULL', [Date.now()]);
    releaseCompare();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await app.db.all('SELECT * FROM gateway_sessions WHERE revoked_at IS NULL')).length, 0);
  } finally {
    releaseCompare();
    bcrypt.compare = originalCompare;
  }
});

test('login rejects cross-origin, missing-origin, and simple cross-site form requests', async () => {
  const app = await harness();
  const cases = [
    { Origin: 'https://attacker.example', 'X-Gatekeeper-Request': '1' },
    { 'X-Gatekeeper-Request': '1' },
    { Origin: 'null', 'X-Gatekeeper-Request': '1' },
    { Origin: GATEWAY_ORIGIN },
  ];
  for (const extra of cases) {
    const response = await app.request('/api/v1/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(response.status, 403);
  }
});

test('forward auth permits a valid session only for a registered application', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  const response = await app.request('/auth/verify', { headers: app.verifyHeaders(cookie) });
  assert.equal(response.status, 204);
});

test('auth decisions and session metadata cannot be cached', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  for (const response of [
    await app.request('/api/v1/session', { headers: { Cookie: cookie } }),
    await app.request('/auth/verify', { headers: app.verifyHeaders(cookie) }),
    await app.request('/auth/verify', { headers: app.verifyHeaders() }),
  ]) {
    assert.match(response.headers.get('cache-control') || '', /no-store/i);
  }
});

test('malformed, forged, and duplicate session cookies never authorize a request', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  for (const value of ['gatekeeper_session=garbage', 'gatekeeper_session=%E0%A4%A', 'gatekeeper_session=' + 'a'.repeat(43), `${cookie}; ${cookie}`]) {
    const response = await app.request('/auth/verify', {
      headers: app.verifyHeaders(value, { Accept: 'application/json' }),
    });
    assert.equal(response.status, 401);
  }
});

test('forward auth fails closed without the private proxy credential', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  for (const secret of ['', 'not-the-private-key']) {
    const response = await app.request('/auth/verify', {
      headers: app.verifyHeaders(cookie, { 'X-Gatekeeper-Proxy-Key': secret }),
    });
    assert.equal(response.status, 403);
  }
});

test('forward auth rejects unregistered origins and hostile forwarded authorities', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  for (const host of ['evil.example', 'localhost:3000.evil.example', 'localhost:3000@evil.example', 'localhost:3000, evil.example']) {
    const response = await app.request('/auth/verify', {
      headers: app.verifyHeaders(cookie, { 'X-Forwarded-Host': host }),
    });
    assert.equal(response.status, 403, `host must be rejected: ${host}`);
  }
  const wrongScheme = await app.request('/auth/verify', {
    headers: app.verifyHeaders(cookie, { 'X-Forwarded-Proto': 'https' }),
  });
  assert.equal(wrongScheme.status, 403);
});

test('forward auth rejects malformed scheme, method, and request URI metadata', async () => {
  const app = await harness();
  const { cookie } = await app.login();
  const cases = [
    { 'X-Forwarded-Proto': 'http,https' },
    { 'X-Forwarded-Method': '' },
    { 'X-Forwarded-Method': 'GET,POST' },
    { 'X-Forwarded-Uri': '//evil.example/' },
    { 'X-Forwarded-Uri': 'https://evil.example/' },
    { 'X-Forwarded-Uri': '/%0d%0aLocation:https://evil.example/' },
    { 'X-Forwarded-Uri': '/%5cevil.example/' },
  ];
  for (const extra of cases) {
    const response = await app.request('/auth/verify', { headers: app.verifyHeaders(cookie, extra) });
    assert.equal(response.status, 403);
  }
});

test('unauthenticated page navigation returns to the exact original allowlisted page after login', async () => {
  const app = await harness();
  const response = await app.request('/auth/verify', { headers: app.verifyHeaders() });
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin, GATEWAY_ORIGIN);
  assert.equal(target.pathname, '/login');
  assert.equal(target.searchParams.get('returnTo'), `${APP_ORIGIN}/private/page?tab=one`);
  const login = await app.login({ password: PASSWORD, returnTo: target.searchParams.get('returnTo') });
  assert.equal((await login.response.json()).redirectTo, `${APP_ORIGIN}/private/page?tab=one`);
});

test('unauthenticated API calls and unsafe methods receive 401 instead of an HTML login redirect', async () => {
  const app = await harness();
  const cases = [
    { Accept: 'application/json' },
    { 'X-Forwarded-Method': 'POST' },
    { 'X-Forwarded-Method': 'DELETE' },
  ];
  for (const extra of cases) {
    const response = await app.request('/auth/verify', { headers: app.verifyHeaders(undefined, extra) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('location'), null);
  }
});

test('login cannot be used as an open redirect', async () => {
  const app = await harness();
  for (const returnTo of ['https://evil.example/', '//evil.example/', `${APP_ORIGIN}.evil.example/`, 'javascript:alert(1)', `${APP_ORIGIN}/%0d%0aLocation:https://evil.example`, `${APP_ORIGIN}/%5cevil`]) {
    const response = await app.request('/api/v1/login', {
      method: 'POST', headers: app.mutationHeaders(),
      body: JSON.stringify({ password: PASSWORD, returnTo }),
    });
    assert.equal(response.status, 400, `return target must be rejected: ${returnTo}`);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('session mutations reject absent or incorrect CSRF tokens and foreign origins', async () => {
  const app = await harness();
  const { cookie, session } = await app.login();
  const cases = [
    app.mutationHeaders(cookie),
    app.mutationHeaders(cookie, 'wrong'),
    { ...app.mutationHeaders(cookie, session.csrfToken), Origin: 'http://localhost:3000' },
  ];
  for (const headers of cases) {
    const response = await app.request('/api/v1/logout', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal((await app.request('/auth/verify', { headers: app.verifyHeaders(cookie) })).status, 204);
});

test('logout revokes the server-side session immediately and clears the browser cookie', async () => {
  const app = await harness();
  const { cookie, session } = await app.login();
  const response = await app.request('/api/v1/logout', {
    method: 'POST', headers: app.mutationHeaders(cookie, session.csrfToken), body: '{}',
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /gatekeeper_session=;/);
  const verify = await app.request('/auth/verify', { headers: app.verifyHeaders(cookie, { Accept: 'application/json' }) });
  assert.equal(verify.status, 401, 'replaying the old cookie must fail');
});

test('expired sessions cannot authorize proxy requests or access the dashboard API', async () => {
  const app = await harness();
  const { cookie, session } = await app.login();
  await app.db.run('UPDATE gateway_sessions SET expires_at = ? WHERE id = ?', [Date.now() - 1000, session.sessionId]);
  const verify = await app.request('/auth/verify', { headers: app.verifyHeaders(cookie, { Accept: 'application/json' }) });
  assert.equal(verify.status, 401);
  assert.equal((await app.request('/api/v1/sessions', { headers: { Cookie: cookie } })).status, 401);
});

test('the owner can revoke another device while keeping the current device signed in', async () => {
  const app = await harness();
  const first = await app.login();
  const second = await app.login();
  const list = await app.request('/api/v1/sessions', { headers: { Cookie: first.cookie } });
  const sessions = (await list.json()).sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find(session => session.id === first.session.sessionId).current, true);
  assert.equal(sessions.find(session => session.id === second.session.sessionId).current, false);
  assert.equal(JSON.stringify(sessions).includes(first.session.csrfToken), false);
  const revoked = await app.request(`/api/v1/sessions/${second.session.sessionId}/revoke`, {
    method: 'POST', headers: app.mutationHeaders(first.cookie, first.session.csrfToken), body: '{}',
  });
  assert.equal(revoked.status, 204);
  assert.equal((await app.request('/auth/verify', { headers: app.verifyHeaders(first.cookie) })).status, 204);
  assert.equal((await app.request('/auth/verify', { headers: app.verifyHeaders(second.cookie, { Accept: 'application/json' }) })).status, 401);
});

test('revoke-others invalidates every other device without ending the current session', async () => {
  const app = await harness();
  const first = await app.login();
  const second = await app.login();
  const third = await app.login();
  const response = await app.request('/api/v1/sessions/revoke-others', {
    method: 'POST', headers: app.mutationHeaders(first.cookie, first.session.csrfToken), body: '{}',
  });
  assert.equal(response.status, 204);
  assert.equal((await app.request('/auth/verify', { headers: app.verifyHeaders(first.cookie) })).status, 204);
  for (const { cookie } of [second, third]) {
    assert.equal((await app.request('/auth/verify', { headers: app.verifyHeaders(cookie, { Accept: 'application/json' }) })).status, 401);
  }
});

test('legacy public JWT and administrator approval endpoints are no longer mounted', async () => {
  const app = await harness();
  for (const path of ['/auth/request?app_id=notes', '/admin/login', '/admin/approve/example', '/admin/apps', '/socket.io/']) {
    const response = await app.request(path, {
      method: path.startsWith('/admin/') ? 'POST' : 'GET',
      headers: { Accept: 'application/json' },
    });
    assert.equal(response.status, 404, `obsolete route must be unavailable: ${path}`);
  }
});

test('additive migration preserves an existing administrator and legacy application data', async () => {
  const databasePath = await temporaryDatabase();
  const legacy = new sqlite3.Database(databasePath);
  const exec = sql => new Promise((resolve, reject) => legacy.exec(sql, error => error ? reject(error) : resolve()));
  const run = (sql, parameters) => new Promise((resolve, reject) => legacy.run(sql, parameters, error => error ? reject(error) : resolve()));
  await exec(`
    CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_key TEXT NOT NULL, redirect_url TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, session_token TEXT, ip_address TEXT, user_agent TEXT, status TEXT DEFAULT 'PENDING', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(app_id) REFERENCES apps(id));
    CREATE TABLE admin (id INTEGER PRIMARY KEY AUTOINCREMENT, password_hash TEXT NOT NULL);
    INSERT INTO apps (id, name, secret_key, redirect_url) VALUES ('old-app', 'Legacy app', 'old-unused-secret', 'https://legacy.example.com');
    INSERT INTO sessions (id, app_id, status) VALUES ('old-session', 'old-app', 'ACTIVE');
  `);
  const originalHash = await bcrypt.hash(PASSWORD, 4);
  await run('INSERT INTO admin (password_hash) VALUES (?)', [originalHash]);
  await new Promise((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()));

  const app = await harness({ DATABASE_PATH: databasePath, ADMIN_PASSWORD: 'replacement-env-password-must-not-reseed' });
  const { session } = await app.login();
  assert.equal(session.authenticated, true, 'existing password must continue to work');
  assert.equal((await app.db.get('SELECT password_hash FROM admin LIMIT 1')).password_hash, originalHash);
  assert.equal((await app.db.get('SELECT COUNT(*) AS count FROM apps')).count, 1);
  assert.equal((await app.db.get('SELECT COUNT(*) AS count FROM sessions')).count, 1);
  const verify = await app.request('/auth/verify', {
    headers: app.verifyHeaders('gatekeeper_token=old-session', { Accept: 'application/json' }),
  });
  assert.equal(verify.status, 401, 'legacy approval records must not grant gateway access');
});

test('server-side sessions survive application recreation against the same persistent database', async () => {
  const databasePath = await temporaryDatabase();
  const first = await harness({ DATABASE_PATH: databasePath });
  const { cookie, session } = await first.login();
  const second = await harness({ DATABASE_PATH: databasePath });
  const response = await second.request('/api/v1/session', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, session.sessionId);
  assert.equal((await second.request('/auth/verify', { headers: second.verifyHeaders(cookie) })).status, 204);
});

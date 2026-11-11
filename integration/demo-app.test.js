const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createDemoServer } = require('./demo-app');

const secret = 'demo-test-proxy-secret-that-is-long-enough';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: new Headers(res.headers),
        text: async () => body,
        json: async () => JSON.parse(body),
      }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function fixture(t, handler) {
  const gateway = http.createServer(handler);
  const gatekeeperUrl = await listen(gateway);
  const demo = createDemoServer({ gatekeeperUrl, proxySecret: secret, port: 3000 });
  const address = await listen(demo);
  t.after(async () => { await close(demo); await close(gateway); });
  return { address, demo, gateway };
}

test('demo forwards trusted metadata, keeps the token out of HTML, and rejects forged host', async t => {
  let metadata;
  const { address } = await fixture(t, (req, res) => {
    metadata = req.headers;
    assert.equal(req.url, '/auth/verify');
    res.writeHead(204).end();
  });
  const response = await request(`${address}/notes?view=private`, {
    headers: {
      Host: 'localhost:3000',
      Cookie: 'gatekeeper_session=do-not-display-this-token',
      Accept: 'text/html',
      'X-Gatekeeper-Proxy-Key': 'forged-key',
      'X-Forwarded-Host': 'attacker.example',
      'X-Forwarded-Uri': '//attacker.example',
    },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your app is private/);
  assert.ok(!html.includes('do-not-display-this-token'));
  assert.equal(metadata['x-gatekeeper-proxy-key'], secret);
  assert.equal(metadata['x-forwarded-host'], 'localhost:3000');
  assert.equal(metadata['x-forwarded-uri'], '/notes?view=private');
  assert.equal(metadata['x-forwarded-method'], 'GET');
  assert.equal(metadata.cookie, 'gatekeeper_session=do-not-display-this-token');

  const forged = await request(address, { headers: { Host: 'attacker.example' } });
  assert.equal(forged.status, 421);
});

test('demo preserves login redirects and denies API requests without serving the app', async t => {
  const { address } = await fixture(t, (req, res) => {
    if (req.headers.accept === 'text/html') {
      res.writeHead(302, { Location: 'http://localhost:4000/login?returnTo=http%3A%2F%2Flocalhost%3A3000%2F' }).end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"Sign in required"}');
    }
  });
  const browser = await request(address, { headers: { Host: 'localhost:3000', Accept: 'text/html' } });
  assert.equal(browser.status, 302);
  assert.match(browser.headers.get('location'), /^http:\/\/localhost:4000\/login\?/);
  const api = await request(`${address}/api/status`, { headers: { Host: 'localhost:3000', Accept: 'application/json' } });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'Sign in required' });
});

test('demo blocks access when Gatekeeper is unavailable', async t => {
  const gateway = http.createServer();
  const gatekeeperUrl = await listen(gateway);
  await close(gateway);
  const demo = createDemoServer({ gatekeeperUrl, proxySecret: secret, port: 3000 });
  const address = await listen(demo);
  t.after(() => close(demo));
  const response = await request(address, { headers: { Host: 'localhost:3000', Accept: 'text/html' } });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Access remains blocked/);
});

test('real Gatekeeper protects the demo through login, logout, and session expiry', async t => {
  const { createApp } = require('../backend/app');
  const { loadConfig } = require('../backend/config');
  const password = 'local-test-password-only';
  const config = loadConfig({
    ADMIN_PASSWORD: password,
    PROXY_AUTH_SECRET: secret,
    GATEKEEPER_URL: 'http://localhost:4000',
    PROTECTED_APPS: '[{"id":"demo","name":"Demo","url":"http://localhost:3000"}]',
    DATABASE_PATH: ':memory:',
  });
  const instance = await createApp({ config });
  const gateway = http.createServer(instance.app);
  const gatekeeperUrl = await listen(gateway);
  const demo = createDemoServer({ gatekeeperUrl, proxySecret: secret, port: 3000 });
  const demoUrl = await listen(demo);
  t.after(async () => { await close(demo); await close(gateway); await instance.close(); });

  const unauthenticated = await request(`${demoUrl}/private?tab=1`, {
    headers: { Host: 'localhost:3000', Accept: 'text/html' },
  });
  assert.equal(unauthenticated.status, 302);
  const loginUrl = new URL(unauthenticated.headers.get('location'));
  assert.equal(loginUrl.origin, config.gatewayUrl);
  assert.equal(loginUrl.searchParams.get('returnTo'), 'http://localhost:3000/private?tab=1');

  const mutationHeaders = {
    Origin: config.gatewayUrl,
    'Content-Type': 'application/json',
    'X-Gatekeeper-Request': '1',
  };
  const login = await request(`${gatekeeperUrl}/api/v1/login`, {
    method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ password, returnTo: loginUrl.searchParams.get('returnTo') }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).redirectTo, 'http://localhost:3000/private?tab=1');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const allowed = await request(`${demoUrl}/private?tab=1`, {
    headers: { Host: 'localhost:3000', Cookie: cookie, Accept: 'text/html' },
  });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /Your app is private/);

  const state = await request(`${gatekeeperUrl}/api/v1/session`, { headers: { Cookie: cookie } });
  const { csrfToken } = await state.json();
  const logout = await request(`${gatekeeperUrl}/api/v1/logout`, {
    method: 'POST',
    headers: { ...mutationHeaders, Cookie: cookie, 'X-CSRF-Token': csrfToken },
    body: '{}',
  });
  assert.equal(logout.status, 204);
  const revoked = await request(demoUrl, { headers: { Host: 'localhost:3000', Cookie: cookie, Accept: 'text/html' } });
  assert.equal(revoked.status, 302);

  const secondLogin = await request(`${gatekeeperUrl}/api/v1/login`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ password }),
  });
  assert.equal(secondLogin.status, 200);
  const expiredCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  await instance.db.run('UPDATE gateway_sessions SET expires_at = ?', [Date.now() - 1000]);
  const expired = await request(`${demoUrl}/api/status`, {
    headers: { Host: 'localhost:3000', Cookie: expiredCookie, Accept: 'application/json' },
  });
  assert.equal(expired.status, 401);
});

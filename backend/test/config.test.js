const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');

const base = {
  NODE_ENV: 'test',
  GATEKEEPER_URL: 'http://localhost:4000',
  PROXY_AUTH_SECRET: 'a-fictional-proxy-secret-with-32-characters',
  PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'http://localhost:3000' }]),
};

test('configuration requires an explicit strong proxy key', () => {
  for (const secret of ['', 'short', 'spaces are not accepted even if long enough', 'replace-with-your-own-random-proxy-secret']) {
    assert.throws(() => loadConfig({ ...base, PROXY_AUTH_SECRET: secret }), /PROXY_AUTH_SECRET/);
  }
});

test('production requires HTTPS for both login and protected application origins', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => loadConfig({
    ...base, NODE_ENV: 'production', GATEKEEPER_URL: 'https://login.example.com', COOKIE_DOMAIN: 'example.com',
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'http://notes.example.com' }]),
  }), /HTTPS/);
});

test('shared subdomain sessions require one explicitly configured common cookie domain', () => {
  const crossSubdomain = {
    ...base, GATEKEEPER_URL: 'https://login.example.com',
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'https://notes.example.com' }]),
  };
  assert.throws(() => loadConfig(crossSubdomain), /COOKIE_DOMAIN/);
  const config = loadConfig({ ...crossSubdomain, COOKIE_DOMAIN: 'example.com' });
  assert.equal(config.secureCookie, true);
  assert.equal(config.cookieDomain, 'example.com');
  assert.throws(() => loadConfig({ ...crossSubdomain, COOKIE_DOMAIN: 'other.example.com' }), /COOKIE_DOMAIN/);
  assert.throws(() => loadConfig({
    ...crossSubdomain, COOKIE_DOMAIN: 'example.com',
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'https://notes.unrelated.com' }]),
  }), /COOKIE_DOMAIN/);
});

test('protected applications must have unique ids and exact HTTP(S) origin URLs', () => {
  const invalidApps = [
    [{ id: 'notes', name: 'Notes', url: 'http://localhost:3000/private' }],
    [{ id: 'notes', name: 'Notes', url: 'http://user:password@localhost:3000' }],
    [{ id: 'notes', name: 'Notes', url: 'javascript:alert(1)' }],
    [{ id: 'notes', name: 'Notes', url: 'http://localhost:4000' }],
    [{ id: 'notes', name: 'Notes', url: 'http://localhost:3000' }, { id: 'notes', name: 'Other', url: 'http://localhost:3001' }],
    [{ id: 'notes', name: 'Notes', url: 'http://localhost:3000' }, { id: 'other', name: 'Other', url: 'http://localhost:3000' }],
  ];
  for (const apps of invalidApps) {
    assert.throws(() => loadConfig({ ...base, PROTECTED_APPS: JSON.stringify(apps) }));
  }
});

test('proxy trust cannot be enabled indiscriminately', () => {
  for (const proxy of ['true', '1', '0.0.0.0/0', '::/0']) {
    assert.throws(() => loadConfig({ ...base, TRUST_PROXY: proxy }), /TRUST_PROXY/);
  }
  assert.equal(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy, false);
});

test('password validation accounts for bcrypt byte limits', () => {
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD: 'short' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD: 'a'.repeat(73) }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD: 'é'.repeat(37) }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD: 'replace-with-your-own-admin-password' }), /ADMIN_PASSWORD/);
  assert.doesNotThrow(() => loadConfig({ ...base, ADMIN_PASSWORD: 'a'.repeat(72) }));
});

test('development UI origin allowances cannot be enabled in production', () => {
  assert.throws(() => loadConfig({
    ...base, NODE_ENV: 'production', GATEKEEPER_URL: 'https://login.example.com', COOKIE_DOMAIN: 'example.com',
    PROTECTED_APPS: JSON.stringify([{ id: 'notes', name: 'Notes', url: 'https://notes.example.com' }]),
    DEV_UI_ORIGIN: 'http://localhost:5173',
  }), /DEV_UI_ORIGIN/);
  assert.throws(() => loadConfig({ ...base, DEV_UI_ORIGIN: 'https://attacker.example' }), /DEV_UI_ORIGIN/);
});

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJourney, getShopifyToken, fallbackMethodLabel } from '../src/shopify.js';
import { buildOrderMessage } from '../src/slack.js';

// Minimal D1 stand-in: only the meta-table token cache is used.
function fakeDb() {
  const meta = new Map();
  return {
    meta,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return meta.has('shopify_token') && sql.startsWith('SELECT') ? { value: meta.get('shopify_token') } : null; },
        async run() { meta.set('shopify_token', args[0]); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
}

const env = () => ({ SHOPIFY_STORE: 'brightside.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', DB: fakeDb() });
const ORDER = { name: '#1001', admin_graphql_api_id: 'gid://shopify/Order/1' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const TOKEN = () => json({ access_token: 'tok', scope: 'read_orders', expires_in: 86399 });

// Routes token and GraphQL calls to the given handlers and records each call.
function mockFetch({ token = TOKEN, graphql }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const kind = String(url).includes('/oauth/access_token') ? 'token' : 'graphql';
    calls.push({ kind, init });
    return kind === 'token' ? token(calls) : graphql(calls, init);
  };
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const quiet = () => { console.log = () => {}; console.warn = () => {}; };
quiet();

test('journey ready → visit, no error', async () => {
  const visit = { landingPage: 'https://drinkbrightside.com/?utm_source=meta', utmParameters: { source: 'meta' } };
  mockFetch({ graphql: () => json({ data: { order: { customerJourneySummary: { ready: true, lastVisit: visit, moments: { nodes: [] } } } } }) });
  const j = await fetchJourney(ORDER, env(), 1);
  assert.equal(j.ready, true);
  assert.equal(j.error, null);
  assert.equal(j.visit.landingPage, visit.landingPage);
});

test('journey not built yet → not ready, no error', async () => {
  mockFetch({ graphql: () => json({ data: { order: { customerJourneySummary: { ready: false } } } }) });
  const j = await fetchJourney(ORDER, env(), 1);
  assert.deepEqual([j.ready, j.error], [false, null]);
});

test('token request rejected → permanent error with Shopify\'s reason', async () => {
  const calls = mockFetch({
    token: () => json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401),
    graphql: () => assert.fail('should not query without a token'),
  });
  const j = await fetchJourney(ORDER, env(), 3);
  assert.equal(j.ready, false);
  assert.equal(j.error.transient, false);
  assert.match(j.error.message, /token request failed \(401\): Client authentication failed/);
  assert.equal(calls.length, 1, 'does not keep retrying a credentials failure');
});

test('403 from the API → permanent error', async () => {
  mockFetch({ graphql: () => new Response('[API] This action requires merchant approval for read_orders scope.', { status: 403 }) });
  const j = await fetchJourney(ORDER, env(), 3);
  assert.equal(j.error.transient, false);
  assert.match(j.error.message, /Shopify API 403: \[API\] This action requires merchant approval/);
});

test('401 → refreshes the token once, then reports the error', async () => {
  const calls = mockFetch({ graphql: () => new Response('Invalid API key or access token', { status: 401 }) });
  const j = await fetchJourney(ORDER, env(), 1);
  assert.deepEqual(calls.map((c) => c.kind), ['token', 'graphql', 'token', 'graphql']);
  assert.equal(j.error.transient, false);
  assert.match(j.error.message, /Shopify API 401/);
});

test('401 with a stale cached token → fresh token succeeds', async () => {
  const e = env();
  e.DB.meta.set('shopify_token', JSON.stringify({ token: 'stale', expiresAt: Date.now() + 3600000 }));
  mockFetch({
    graphql: (calls, init) => (init.headers['X-Shopify-Access-Token'] === 'stale'
      ? new Response('Invalid API key or access token', { status: 401 })
      : json({ data: { order: { customerJourneySummary: { ready: true, lastVisit: null } } } })),
  });
  const j = await fetchJourney(ORDER, e, 1);
  assert.deepEqual([j.ready, j.error], [true, null]);
});

test('GraphQL errors on both queries → permanent error naming the problem', async () => {
  const calls = mockFetch({
    graphql: () => json({ errors: [{ message: 'Access denied for customerJourneySummary field.', extensions: { code: 'ACCESS_DENIED' } }] }),
  });
  const j = await fetchJourney(ORDER, env(), 3);
  assert.equal(calls.filter((c) => c.kind === 'graphql').length, 2, 'full query, then the basic fallback');
  assert.equal(j.error.transient, false);
  assert.match(j.error.message, /ACCESS_DENIED: Access denied for customerJourneySummary/);
});

test('GraphQL error on full query only → falls back to basic query', async () => {
  mockFetch({
    graphql: (calls, init) => (JSON.parse(init.body).query.includes('moments')
      ? json({ errors: [{ message: "Field 'moments' doesn't exist" }] })
      : json({ data: { order: { customerJourneySummary: { ready: true, lastVisit: null } } } })),
  });
  const j = await fetchJourney(ORDER, env(), 1);
  assert.deepEqual([j.ready, j.error], [true, null]);
});

test('order not visible to the app → permanent error', async () => {
  mockFetch({ graphql: () => json({ data: { order: null } }) });
  const j = await fetchJourney(ORDER, env(), 1);
  assert.equal(j.error.transient, false);
  assert.match(j.error.message, /no order for gid:\/\/shopify\/Order\/1/);
});

test('rate limit / 5xx / network → transient error', async () => {
  mockFetch({ graphql: () => new Response('busy', { status: 503 }) });
  assert.equal((await fetchJourney(ORDER, env(), 1)).error.transient, true);
  mockFetch({ graphql: () => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }) });
  assert.equal((await fetchJourney(ORDER, env(), 1)).error.transient, true);
  mockFetch({ graphql: () => { throw new TypeError('fetch failed'); } });
  assert.equal((await fetchJourney(ORDER, env(), 1)).error.transient, true);
});

test('token is cached and reused', async () => {
  const e = env();
  const calls = mockFetch({ graphql: () => json({ data: { order: { customerJourneySummary: { ready: false } } } }) });
  await getShopifyToken(e);
  await getShopifyToken(e);
  assert.equal(calls.filter((c) => c.kind === 'token').length, 1);
});

test('Slack footer shows the lookup error instead of "not ready"', () => {
  const err = Object.assign(new Error('Shopify API 403: <scope> missing & denied'), { transient: false });
  assert.equal(fallbackMethodLabel({ error: null }, 10), 'landing_site (Shopify visit data not ready after 10 min)');
  const method = fallbackMethodLabel({ error: err }, 10);
  assert.equal(method, 'landing_site (Shopify lookup failed: Shopify API 403: <scope> missing & denied)');

  const rec = { id: '1', name: '#1001', created_at: '2026-10-28T15:00:00Z', total_cents: 5400, currency: 'USD', items: [] };
  const attr = { method, source: '(direct)', medium: '(none)', clickIds: [] };
  const { blocks } = buildOrderMessage(rec, attr, { SHOPIFY_STORE: 's.myshopify.com' });
  const footer = blocks.at(-1).elements[0].text;
  assert.match(footer, /attribution: landing_site \(Shopify lookup failed: Shopify API 403: &lt;scope&gt; missing &amp; denied\)/);
});

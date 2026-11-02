// End-to-end test support: runs the real Worker against an in-memory SQLite database (standing in
// for D1) and fake Shopify, Slack and Google Sheets endpoints. Needs Node 22.5+ (node:sqlite).
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

let DatabaseSync = null;
try {
  process.removeAllListeners('warning'); // node:sqlite prints an "experimental" warning
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* older Node: e2e tests are skipped */ }
export const sqliteAvailable = !!DatabaseSync;

const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      };
      return stmt;
    },
  };
}

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

// A fresh world per test: database, env, fake services and helpers to drive the Worker.
export async function createWorld() {
  const worker = (await import('../../src/index.js')).default;
  const db = makeDb();
  const w = {
    db,
    journeys: new Map(), // order gid -> customerJourneySummary, or a function returning one / a Response
    slackPosts: [], // { ts, text, blocks }
    slackEdits: [],
    slackFail: {}, // Slack method -> error code to return
    sheet: new Map(), // order id -> row
    env: {
      DB: db, ADMIN_KEY: 'admin', SHOPIFY_WEBHOOK_SECRET: 'whsec', SLACK_BOT_TOKEN: 'xoxb', SHEETS_SECRET: 's',
      SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE: 'brightside.myshopify.com',
      STOREFRONT_DOMAIN: 'drinkbrightside.com', SLACK_CHANNEL_ID: 'C1', STORE_TIMEZONE: 'America/New_York',
      WEEK_START: '1', ONLINE_SOURCE_NAMES: 'web', ATTRIBUTION: 'last_non_direct', DASHBOARD_MODE: 'canvas',
      CURRENCY: 'USD', POST_MAX_WAIT_MINUTES: '10', SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/x/exec',
    },
  };
  let ts = 1000;

  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('/admin/oauth/access_token')) return json({ access_token: 'tok', scope: 'read_orders', expires_in: 86399 });
    if (url.includes('/graphql.json')) {
      const { variables } = JSON.parse(init.body);
      let s = w.journeys.get(variables?.id);
      if (typeof s === 'function') s = s();
      if (s instanceof Response) return s;
      return json({ data: { order: { customerJourneySummary: s ?? { ready: false } } } });
    }
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.split('/api/')[1];
      const p = Object.fromEntries(new URLSearchParams(init.body));
      if (w.slackFail[method]) return json({ ok: false, error: w.slackFail[method] });
      if (method === 'chat.postMessage') {
        const post = { ts: String(++ts), text: p.text, blocks: JSON.parse(p.blocks || '[]') };
        w.slackPosts.push(post);
        return json({ ok: true, ts: post.ts });
      }
      if (method === 'chat.update') {
        w.slackEdits.push(p.ts);
        Object.assign(w.slackPosts.find((m) => m.ts === p.ts) || {}, { text: p.text, blocks: JSON.parse(p.blocks || '[]') });
        return json({ ok: true });
      }
      if (method === 'conversations.history') {
        return json({ ok: true, has_more: false, messages: [...w.slackPosts].reverse().map((m) => ({ ...m, bot_id: 'B1' })) });
      }
      if (method === 'conversations.canvases.create') return json({ ok: true, canvas_id: 'F1' });
      return json({ ok: true });
    }
    if (url.startsWith('https://script.google.com/')) {
      const b = JSON.parse(init.body);
      let added = 0;
      let updated = 0;
      for (const o of b.orders) {
        if (!w.sheet.has(o.id)) { w.sheet.set(o.id, o); added++; } else if (b.update) { w.sheet.set(o.id, o); updated++; }
      }
      return json({ ok: true, added, updated });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  Object.assign(w, {
    async webhook(order) {
      const body = JSON.stringify(order);
      const hmac = crypto.createHmac('sha256', w.env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64');
      const waits = [];
      const req = new Request('https://bell/webhooks/shopify/orders-create', { method: 'POST', body, headers: { 'x-shopify-hmac-sha256': hmac } });
      const res = await worker.fetch(req, w.env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      return res;
    },
    tick: (cron = '* * * * *') => worker.scheduled({ cron }, w.env, { waitUntil() {} }),
    async admin(path) {
      const res = await worker.fetch(new Request(`https://bell${path}`, { method: 'POST', headers: { 'x-admin-key': 'admin' } }), w.env, {});
      return res.text();
    },
    row: (id) => db.raw.prepare('SELECT * FROM orders WHERE id = ?').get(String(id)),
    footer: (post) => post.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text).join(' | '),
  });
  return w;
}

export function order(id, minutesAgo = 0, extra = {}) {
  return {
    id, name: `#${id}`, admin_graphql_api_id: `gid://shopify/Order/${id}`, source_name: 'web', total_price: '40.00',
    currency: 'USD', created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(), landing_site: '/', referring_site: null,
    line_items: [{ title: 'Guava Glow', variant_title: '12-pack', quantity: 1 }], ...extra,
  };
}

export const META_VISIT = {
  landingPage: 'https://drinkbrightside.com/?utm_source=meta&utm_medium=paid-social&utm_campaign=c1',
  referrerUrl: null, occurredAt: '2026-11-01T10:00:00Z', utmParameters: { source: 'meta', medium: 'paid-social', campaign: 'c1' },
};
export const ready = (visit = META_VISIT) => ({ ready: true, lastVisit: visit, firstVisit: visit, moments: { nodes: [] } });

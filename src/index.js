// Brightside Order Bell — Cloudflare Worker
// Shopify orders/create webhook → Slack bell message + running tally tab

import { resolveAttribution } from './utm.js';
import { postOrderMessage, updateOrderMessage, slackApi } from './slack.js';
import { parseLandingUrl } from './utm.js';
import { refreshDashboard, localYmd } from './dashboard.js';
import { sendToSheet, syncSheet } from './sheets.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhooks/shopify/orders-create') {
      return handleShopifyWebhook(request, env, ctx);
    }

    // Admin helpers (require header x-admin-key: <ADMIN_KEY>)
    if (url.pathname.startsWith('/admin/')) {
      if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        if (url.pathname === '/admin/test') {
          await processOrder(sampleOrder(env), env, { isTest: true });
          return new Response('Test order posted to Slack (not counted in totals).');
        }
        if (url.pathname === '/admin/refresh') {
          await refreshDashboard(env);
          return new Response('Dashboard refreshed.');
        }
        if (url.pathname === '/admin/shopify-check') {
          // Read-only: gets a token and reads the shop name + latest order's journey. Changes nothing in Shopify.
          const token = await getShopifyToken(env, true);
          if (!token) return new Response('No Shopify credentials set (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET).');
          const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${env.SHOPIFY_API_VERSION || '2026-07'}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ query: `{ shop { name } orders(first: 1, reverse: true) { nodes { name customerJourneySummary { ready lastVisit { landingPage } } } } }` }),
          });
          return new Response(`Shopify check (${r.status}): ${await r.text()}`);
        }
        if (url.pathname === '/admin/recheck') {
          // Optional query params: ?days=60 (how far back), ?all=1 (also re-check already-fixed orders)
          const days = Number(url.searchParams.get('days')) || 60;
          const all = url.searchParams.get('all') === '1';
          await ensureSchema(env);
          const r = await recheckOrders(env, { days, all });
          const lines = [
            `Re-checked ${r.checked} orders from the last ${days} days. ${r.updated} updated from Shopify's customer journey.`,
            r.changes.length ? `Attribution changed:\n  ${r.changes.join('\n  ')}` : 'No attribution changes.',
            `Google Sheet: ${r.sheet}`,
            r.notReady ? `${r.notReady} orders had no journey data ready yet (they'll be retried).` : '',
            r.remaining ? `${r.remaining} orders still to check — run this command again.` : 'All done.',
          ].filter(Boolean);
          return new Response(lines.join('\n'));
        }
        if (url.pathname === '/admin/fix-slack') {
          // Run /admin/recheck first so the stored data is correct, then this edits the posts to match.
          const days = Number(url.searchParams.get('days')) || 60;
          const r = await fixSlackPosts(env, { days, all: url.searchParams.get('all') === '1' });
          const lines = [
            `Found ${r.scanned} order posts in the last ${days} days. Edited ${r.fixed.length}:`,
            ...r.fixed.map((f) => '  ' + f),
            r.notFound.length ? `Not in the database (posted before tracking started): ${r.notFound.join(', ')}` : '',
            r.remaining ? `${r.remaining} more to edit — run this command again.` : 'All done.',
          ].filter(Boolean);
          return new Response(lines.join('\n'));
        }
        if (url.pathname === '/admin/sync-sheet') {
          // Copies every stored real order to the Google Sheet (skips ones already there)
          const r = await syncSheet(env, null);
          return new Response(`Sheet sync OK: ${JSON.stringify(r)}`);
        }
      } catch (e) {
        return new Response('ERROR: ' + (e.stack || e.message), { status: 500 });
      }
    }

    return new Response('Order Bell is running.', { status: url.pathname === '/' ? 200 : 404 });
  },

  // Hourly (see [triggers] in wrangler.toml): rolls WTD/MTD over on the canvas even with no new
  // orders, and re-sends recent orders to the sheet so any missed row fills itself in.
  async scheduled(event, env, ctx) {
    if (event.cron !== '0 * * * *') {
      await processPending(env); // every minute: ring the bell for held orders
      return;
    }
    // Hourly: re-check the last 3 days, roll the canvas over, fill any missing sheet rows.
    await ensureSchema(env);
    const jobs = [
      recheckOrders(env, { days: 3, limit: 20 }).then((r) => r.changes.length && console.log('Recheck:', r.changes.join('; '))),
      refreshDashboard(env),
      syncSheet(env, 35),
    ];
    const results = await Promise.allSettled(jobs);
    results.forEach((r) => r.status === 'rejected' && console.error('scheduled job failed', r.reason?.stack || r.reason));
  },
};

async function handleShopifyWebhook(request, env, ctx) {
  const raw = await request.arrayBuffer();
  const ok = await verifyShopifyHmac(raw, request.headers.get('x-shopify-hmac-sha256'), env.SHOPIFY_WEBHOOK_SECRET);
  if (!ok) return new Response('Invalid signature', { status: 401 });

  const order = JSON.parse(new TextDecoder().decode(raw));
  // Shopify wants a fast 200 (<5s); do the Slack work in the background.
  ctx.waitUntil(processOrder(order, env).catch((e) => console.error('processOrder failed', order?.id, e.stack || e)));
  return new Response('ok');
}

async function verifyShopifyHmac(rawBody, header, secret) {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

const hasShopifyCreds = (env) => !!(env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET));

async function processOrder(order, env, { isTest = false } = {}) {
  // Only online-store orders (skip POS, draft orders, wholesale apps, etc.)
  const onlineSources = (env.ONLINE_SOURCE_NAMES || 'web').split(',').map((s) => s.trim());
  if (!isTest && !onlineSources.includes(order.source_name)) {
    console.log(`Skipping order ${order.name}: source_name=${order.source_name}`);
    return;
  }
  const isShopifyTest = order.test === true; // bogus-gateway test checkouts
  console.log(`Order ${order.name}: source_name=${order.source_name} total=${order.total_price} landing_site=${order.landing_site} referring_site=${order.referring_site}`);
  if (!isTest && env.SKIP_ZERO_DOLLAR_ORDERS === 'true' && !(parseFloat(order.total_price || '0') > 0)) {
    console.log(`Skipping $0 order ${order.name}`);
    return;
  }

  const attr = resolveAttribution({
    landingSite: order.landing_site,
    referringSite: order.referring_site,
    storefrontDomain: env.STOREFRONT_DOMAIN,
  });
  const tz = env.STORE_TIMEZONE || 'America/New_York';
  const createdAt = new Date(order.created_at || Date.now()).toISOString();
  const rec = {
    id: String(order.id),
    name: order.name || `#${order.order_number}`,
    created_at: createdAt,
    local_date: localYmd(new Date(createdAt), tz),
    total_cents: Math.round(parseFloat(order.total_price || '0') * 100),
    currency: order.currency || env.CURRENCY || 'USD',
    items: (order.line_items || []).map(
      (li) => `${li.quantity}× ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`,
    ),
  };

  // Admin test + Shopify bogus-gateway orders: post right away, never stored or counted.
  if (isTest || isShopifyTest) {
    await postOrderMessage(rec, attr, env, { isTest: true });
    await refreshDashboard(env);
    return;
  }

  await ensureSchema(env);
  // Stored as pending (posted = 0). INSERT OR IGNORE = idempotent against Shopify webhook retries.
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders
      (id, name, created_at, local_date, total_cents, currency, items,
       landing_page, full_url, source, medium, campaign, content, term, referrer, attribution_method, posted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).bind(
    rec.id, rec.name, rec.created_at, rec.local_date, rec.total_cents, rec.currency, JSON.stringify(rec.items),
    attr.landingPage, attr.fullUrl, attr.source, attr.medium, attr.campaign, attr.content, attr.term,
    attr.referrer, attr.method,
  ).run();
  if (res.meta.changes === 0) return; // already received

  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(rec.id).first();
  if (!hasShopifyCreds(env)) return finalizeOrder(env, row, { ready: false, visit: null });

  // Quick first look; if Shopify's journey isn't ready yet, the per-minute job keeps checking.
  const journey = await fetchJourney({ name: rec.name, admin_graphql_api_id: order.admin_graphql_api_id }, env, 1);
  if (journey.ready) return finalizeOrder(env, row, journey);
  console.log(`${rec.name}: journey not ready yet — holding the bell`);
}

let schemaChecked = false;
async function ensureSchema(env) {
  if (schemaChecked) return;
  const { results } = await env.DB.prepare('PRAGMA table_info(orders)').all();
  if (!results.some((c) => c.name === 'posted')) {
    // Existing rows were already posted before this feature existed.
    await env.DB.prepare('ALTER TABLE orders ADD COLUMN posted INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!results.some((c) => c.name === 'slack_ts')) {
    await env.DB.prepare('ALTER TABLE orders ADD COLUMN slack_ts TEXT').run(); // Slack message id, for edits
  }
  schemaChecked = true;
}

// Final attribution → Slack bell → canvas → sheet. Runs once per order.
async function finalizeOrder(env, row, journey, { timedOut = false } = {}) {
  const attr = resolveAttribution({
    landingSite: row.full_url,
    referringSite: row.referrer,
    journeyVisit: journey.visit,
    storefrontDomain: env.STOREFRONT_DOMAIN,
  });
  const storedMethod = journey.visit ? attr.method : journey.ready ? 'journey_no_visits' : 'landing_site';

  // Claim the order atomically so the webhook and the per-minute job can't both post it.
  const claim = await env.DB.prepare(
    `UPDATE orders SET posted = 1, landing_page = ?, full_url = ?, source = ?, medium = ?, campaign = ?, content = ?,
       term = ?, referrer = ?, attribution_method = ? WHERE id = ? AND posted = 0`,
  ).bind(attr.landingPage, attr.fullUrl, attr.source, attr.medium, attr.campaign, attr.content, attr.term,
    attr.referrer, storedMethod, row.id).run();
  if (claim.meta.changes === 0) return;

  const rec = { ...row, items: JSON.parse(row.items || '[]') };
  const display = { ...attr };
  if (timedOut) display.method = `landing_site (Shopify visit data not ready after ${env.POST_MAX_WAIT_MINUTES || 10} min)`;

  const sheetRow = { ...row, landing_page: attr.landingPage, full_url: attr.fullUrl, source: attr.source, medium: attr.medium,
    campaign: attr.campaign, content: attr.content, term: attr.term, referrer: attr.referrer, attribution_method: storedMethod };

  const [slackRes, sheetRes] = await Promise.allSettled([
    (async () => {
      const ts = await postOrderMessage(rec, display, env);
      if (ts) await env.DB.prepare('UPDATE orders SET slack_ts = ? WHERE id = ?').bind(ts, row.id).run();
      await refreshDashboard(env);
    })(),
    sendToSheet([sheetRow], env, { update: true }),
  ]);
  if (slackRes.status === 'rejected') {
    console.error('Slack post failed', row.name, slackRes.reason?.stack || slackRes.reason);
    // Let the per-minute job retry the bell, but not forever.
    if (Date.now() - Date.parse(row.created_at) < 60 * 60000) {
      await env.DB.prepare('UPDATE orders SET posted = 0 WHERE id = ?').bind(row.id).run();
    }
  }
  if (sheetRes.status === 'rejected') console.error('Sheet failed', row.name, sheetRes.reason?.message);
}

// Every minute: post held orders once Shopify's journey is ready, or after POST_MAX_WAIT_MINUTES.
async function processPending(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT * FROM orders WHERE posted = 0 ORDER BY created_at ASC LIMIT 20').all();
  const maxWaitMs = (Number(env.POST_MAX_WAIT_MINUTES) || 10) * 60000;
  for (const row of results) {
    try {
      const journey = hasShopifyCreds(env)
        ? await fetchJourney({ name: row.name, admin_graphql_api_id: `gid://shopify/Order/${row.id}` }, env, 1)
        : { ready: false, visit: null };
      const timedOut = Date.now() - Date.parse(row.created_at) > maxWaitMs;
      if (journey.ready || timedOut || !hasShopifyCreds(env)) {
        await finalizeOrder(env, row, journey, { timedOut: !journey.ready && hasShopifyCreds(env) });
      }
    } catch (e) {
      console.error('pending order failed', row.name, e.stack || e);
    }
  }
}

// Optional: richer attribution from Shopify's customer journey (needs SHOPIFY_ADMIN_TOKEN with read_orders).
// ATTRIBUTION modes:
//   last_non_direct (default) = most recent visit that had UTMs or an ad click ID, else the last visit
//   last  = the visit that placed the order (same as Shopify's landing_site)
//   first = the customer's first recorded visit
const VISIT_FIELDS = 'landingPage referrerUrl occurredAt utmParameters { source medium campaign content term }';
const JOURNEY_QUERY_FULL = `query ($id: ID!) { order(id: $id) { customerJourneySummary {
  ready firstVisit { ${VISIT_FIELDS} } lastVisit { ${VISIT_FIELDS} }
  moments(first: 50) { nodes { ... on CustomerVisit { ${VISIT_FIELDS} } } }
} } }`;
const JOURNEY_QUERY_BASIC = `query ($id: ID!) { order(id: $id) { customerJourneySummary {
  ready firstVisit { ${VISIT_FIELDS} } lastVisit { ${VISIT_FIELDS} }
} } }`;

const isTaggedVisit = (v) =>
  !!(v && (v.utmParameters?.source || v.utmParameters?.campaign ||
    /[?&](utm_source|gclid|gbraid|wbraid|srsltid|fbclid|ttclid|msclkid)=/i.test(v.landingPage || '')));

function pickVisit(s, mode) {
  if (mode === 'first') return s.firstVisit || s.lastVisit || null;
  if (mode === 'last') return s.lastVisit || s.firstVisit || null;
  const visits = [...(s.moments?.nodes || []), s.firstVisit, s.lastVisit].filter((v) => v && v.landingPage);
  const tagged = visits.filter(isTaggedVisit).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  return tagged.length ? tagged[tagged.length - 1] : s.lastVisit || s.firstVisit || null;
}

// Admin API token: either a static legacy token (SHOPIFY_ADMIN_TOKEN) or, for Dev Dashboard apps,
// exchanged from SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client credentials grant) and cached ~until expiry.
async function getShopifyToken(env, forceRefresh = false) {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return null;
  if (!forceRefresh) {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'shopify_token'").first();
    if (row) {
      const { token, expiresAt } = JSON.parse(row.value);
      if (Date.now() < expiresAt) return token;
    }
  }
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Shopify token request failed (${r.status}): ${text.slice(0, 200)}`); }
  if (!j.access_token) throw new Error(`Shopify token request failed (${r.status}): ${text.slice(0, 300)}`);
  const expiresAt = Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000; // refresh 5 min early
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('shopify_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ token: j.access_token, expiresAt })).run();
  console.log(`Got Shopify token (scopes: ${j.scope}, expires in ${j.expires_in}s)`);
  return j.access_token;
}

// Returns { ready, visit }. ready=false means Shopify hadn't finished building the journey yet.
async function fetchJourney(order, env, attempts = 5) {
  if (!order.admin_graphql_api_id) return { ready: false, visit: null };
  let token;
  try {
    token = await getShopifyToken(env);
  } catch (e) {
    console.warn(e.message);
    return { ready: false, visit: null };
  }
  if (!token) return { ready: false, visit: null };
  const endpoint = `https://${env.SHOPIFY_STORE}/admin/api/${env.SHOPIFY_API_VERSION || '2026-07'}/graphql.json`;
  let query = JOURNEY_QUERY_FULL;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables: { id: order.admin_graphql_api_id } }),
      });
      if (r.status === 401 && !env.SHOPIFY_ADMIN_TOKEN) { token = await getShopifyToken(env, true); continue; }
      const j = await r.json();
      if (j.errors) {
        console.warn(`Journey query errors for ${order.name}:`, JSON.stringify(j.errors).slice(0, 500));
        if (query === JOURNEY_QUERY_FULL) { query = JOURNEY_QUERY_BASIC; attempt--; continue; } // retry with simpler query
      }
      const s = j?.data?.order?.customerJourneySummary;
      if (s?.ready) {
        const v = pickVisit(s, env.ATTRIBUTION || 'last_non_direct');
        console.log(`Journey for ${order.name} (${env.ATTRIBUTION || 'last_non_direct'}): ${v ? v.landingPage : 'no visits recorded'}`);
        return { ready: true, visit: v };
      }
    } catch (e) {
      console.warn('journey lookup failed', e.message);
    }
    if (attempt < attempts - 1) await new Promise((res) => setTimeout(res, 5000)); // journey data can lag the webhook
  }
  return { ready: false, visit: null };
}

async function fetchJourneyVisit(order, env) {
  return (await fetchJourney(order, env)).visit; // null → fall back to landing_site
}

// Re-checks stored orders against Shopify's customer journey and fixes their attribution
// in the database, the canvas and the Google Sheet. Read-only on the Shopify side.
// Orders already attributed from the journey are skipped unless all=true.
async function recheckOrders(env, { days = 60, limit = 35, all = false } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const pending = all
    ? `1 = 1`
    : `(attribution_method IS NULL OR attribution_method NOT IN ('customer_journey', 'journey_no_visits'))`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders WHERE posted = 1 AND created_at >= ? AND ${pending} ORDER BY created_at DESC LIMIT ?`,
  ).bind(since, limit).all();

  const changes = [];
  const updated = [];
  let notReady = 0;
  for (const o of results) {
    const { ready, visit } = await fetchJourney({ name: o.name, admin_graphql_api_id: `gid://shopify/Order/${o.id}` }, env, 1);
    if (!ready) { notReady++; continue; }
    if (!visit) {
      await env.DB.prepare(`UPDATE orders SET attribution_method = 'journey_no_visits' WHERE id = ?`).bind(o.id).run();
      continue;
    }
    const a = resolveAttribution({ landingSite: o.full_url, referringSite: o.referrer, journeyVisit: visit, storefrontDomain: env.STOREFRONT_DOMAIN });
    await env.DB.prepare(
      `UPDATE orders SET landing_page = ?, full_url = ?, source = ?, medium = ?, campaign = ?, content = ?, term = ?,
         referrer = ?, attribution_method = ? WHERE id = ?`,
    ).bind(a.landingPage, a.fullUrl, a.source, a.medium, a.campaign, a.content, a.term, a.referrer, a.method, o.id).run();
    const row = { ...o, landing_page: a.landingPage, full_url: a.fullUrl, source: a.source, medium: a.medium,
      campaign: a.campaign, content: a.content, term: a.term, referrer: a.referrer, attribution_method: a.method };
    updated.push(row);
    const before = `${o.source} / ${o.medium}`;
    const after = `${a.source} / ${a.medium}`;
    if (before !== after || (o.campaign || '') !== (a.campaign || '') || (o.term || '') !== (a.term || '')) {
      changes.push(`${o.name}: ${before} → ${after}${a.campaign ? ` [${a.campaign}${a.term ? ' · ' + a.term : ''}]` : ''}`);
      if (o.slack_ts) {
        try {
          await updateOrderMessage(o.slack_ts, { ...row, items: JSON.parse(row.items || '[]') }, a, env, editedNote(env));
        } catch (e) {
          console.warn(`Slack edit failed for ${o.name}: ${e.message}`);
        }
      }
    }
  }

  let sheet = 'not configured';
  if (updated.length && env.SHEETS_WEBHOOK_URL) {
    try {
      const r = await sendToSheet(updated, env, { update: true });
      sheet = `updated ${r.updated ?? 0} rows, added ${r.added ?? 0}`;
    } catch (e) {
      sheet = `FAILED: ${e.message}`;
    }
  } else if (env.SHEETS_WEBHOOK_URL) sheet = 'nothing to update';
  if (updated.length) await refreshDashboard(env);

  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE posted = 1 AND created_at >= ? AND ${pending}`).bind(since).first();
  return { checked: results.length, updated: updated.length, notReady, changes, sheet, remaining: all ? 0 : left.n };
}

function editedNote(env) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: env.STORE_TIMEZONE || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date());
  return `Attribution updated from Shopify's visit data (${when})`;
}

// Rebuilds the Slack-post attribution from a stored order row.
function attrFromRow(r) {
  const parsed = parseLandingUrl(r.full_url);
  const unknown = r.source === '(unknown)';
  return {
    landingPage: r.landing_page, fullUrl: r.full_url, source: r.source, medium: r.medium,
    campaign: r.campaign, content: r.content, term: r.term, referrer: r.referrer,
    clickIds: parsed.clickIds, method: r.attribution_method || 'landing_site',
    inferred: unknown || r.source === '(direct)' || (!parsed.utm.source && r.attribution_method !== 'customer_journey'),
    inferredFrom: unknown ? 'no_visit_data' : r.source === '(direct)' ? 'direct' : parsed.clickIds.length ? 'click_id' : 'referrer',
    urlRebuilt: false,
  };
}

// Finds existing order posts in the channel and edits them to match the stored (corrected) data.
// Needs the channels:history scope (groups:history for a private channel).
async function fixSlackPosts(env, { days = 60, all = false } = {}) {
  await ensureSchema(env);
  const oldest = String(Math.floor((Date.now() - days * 86400000) / 1000));
  const found = new Map(); // order name -> ts
  let cursor;
  for (let page = 0; page < 5; page++) {
    const h = await slackApi('conversations.history', { channel: env.SLACK_CHANNEL_ID, oldest, limit: 200, cursor }, env);
    for (const m of h.messages || []) {
      if (!m.bot_id) continue;
      const match = /^New online order (#\S+) —/.exec(m.text || ''); // skips [TEST] posts
      if (match && !found.has(match[1])) found.set(match[1], m.ts);
    }
    cursor = h.response_metadata?.next_cursor;
    if (!cursor || !h.has_more) break;
  }

  const fixed = [];
  const notFound = [];
  let remaining = 0;
  for (const [name, ts] of found) {
    const row = await env.DB.prepare('SELECT * FROM orders WHERE name = ?').bind(name).first();
    if (!row) { notFound.push(name); continue; }
    if (!all && row.slack_ts === ts) continue; // already linked = already accurate
    if (fixed.length >= 30) { remaining++; continue; } // stay under Cloudflare's per-run request limit
    await updateOrderMessage(ts, { ...row, items: JSON.parse(row.items || '[]') }, attrFromRow(row), env, editedNote(env));
    await env.DB.prepare('UPDATE orders SET slack_ts = ? WHERE id = ?').bind(ts, row.id).run();
    fixed.push(`${name}: ${row.source} / ${row.medium}`);
  }
  return { scanned: found.size, fixed, notFound, remaining };
}

function sampleOrder(env) {
  return {
    id: 1000000000001,
    name: '#TEST-1001',
    source_name: 'web',
    created_at: new Date().toISOString(),
    total_price: '54.00',
    currency: env.CURRENCY || 'USD',
    landing_site:
      '/pages/smitten-with-the-small-stuff?&utm_source=meta&utm_medium=paid-social&utm_campaign=sales-excl-customers&utm_term=smitten-if-your-vibe-cali-7s&utm_content=sales-LAL-customers',
    referring_site: 'https://l.facebook.com/',
    line_items: [
      { title: 'Sample Product A', variant_title: '12-pack', quantity: 2 },
      { title: 'Sample Product B', variant_title: null, quantity: 1 },
    ],
  };
}

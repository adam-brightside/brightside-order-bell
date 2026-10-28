// Brightside Order Bell — Cloudflare Worker
// Shopify orders/create webhook → Slack bell message + running tally tab

import { resolveAttribution } from './utm.js';
import { postOrderMessage } from './slack.js';
import { refreshDashboard, localYmd } from './dashboard.js';

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
      if (url.pathname === '/admin/test') {
        await processOrder(sampleOrder(env), env, { isTest: true });
        return new Response('Test order posted to Slack (not counted in totals).');
      }
      if (url.pathname === '/admin/refresh') {
        await refreshDashboard(env);
        return new Response('Dashboard refreshed.');
      }
    }

    return new Response('Order Bell is running.', { status: url.pathname === '/' ? 200 : 404 });
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

async function processOrder(order, env, { isTest = false } = {}) {
  // Only online-store orders (skip POS, draft orders, wholesale apps, etc.)
  const onlineSources = (env.ONLINE_SOURCE_NAMES || 'web').split(',').map((s) => s.trim());
  if (!isTest && !onlineSources.includes(order.source_name)) {
    console.log(`Skipping order ${order.name}: source_name=${order.source_name}`);
    return;
  }
  const isShopifyTest = order.test === true; // bogus-gateway test checkouts

  const journeyVisit = isTest ? null : await fetchJourneyVisit(order, env);
  const attr = resolveAttribution({
    landingSite: order.landing_site,
    referringSite: order.referring_site,
    journeyVisit,
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

  if (!isTest && !isShopifyTest) {
    // INSERT OR IGNORE = idempotent against Shopify webhook retries
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO orders
        (id, name, created_at, local_date, total_cents, currency, items,
         landing_page, full_url, source, medium, campaign, content, term, referrer, attribution_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      rec.id, rec.name, rec.created_at, rec.local_date, rec.total_cents, rec.currency, JSON.stringify(rec.items),
      attr.landingPage, attr.fullUrl, attr.source, attr.medium, attr.campaign, attr.content, attr.term,
      attr.referrer, attr.method,
    ).run();
    if (res.meta.changes === 0) return; // already processed
  }

  await postOrderMessage(rec, attr, env, { isTest: isTest || isShopifyTest });
  await refreshDashboard(env);
}

// Optional: richer attribution from Shopify's customer journey (needs SHOPIFY_ADMIN_TOKEN with read_orders)
async function fetchJourneyVisit(order, env) {
  if (!env.SHOPIFY_ADMIN_TOKEN || !order.admin_graphql_api_id) return null;
  const query = `query ($id: ID!) {
    order(id: $id) {
      customerJourneySummary {
        ready
        firstVisit { ...V }
        lastVisit { ...V }
      }
    }
  }
  fragment V on CustomerVisit {
    landingPage
    referrerUrl
    utmParameters { source medium campaign content term }
  }`;
  const endpoint = `https://${env.SHOPIFY_STORE}/admin/api/${env.SHOPIFY_API_VERSION || '2026-07'}/graphql.json`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN },
        body: JSON.stringify({ query, variables: { id: order.admin_graphql_api_id } }),
      });
      const j = await r.json();
      const s = j?.data?.order?.customerJourneySummary;
      if (s?.ready) {
        const preferred = env.ATTRIBUTION === 'first' ? s.firstVisit : s.lastVisit;
        return preferred || s.lastVisit || s.firstVisit || null;
      }
    } catch (e) {
      console.warn('journey lookup failed', e.message);
    }
    await new Promise((res) => setTimeout(res, 4000)); // journey data can lag the webhook a few seconds
  }
  return null; // fall back to landing_site
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

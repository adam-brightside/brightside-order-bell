// Shopify Admin API: access token + customer-journey lookup for an order

export const hasShopifyCreds = (env) => !!(env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET));

const apiVersion = (env) => env.SHOPIFY_API_VERSION || '2026-07';
export const graphqlEndpoint = (env) => `https://${env.SHOPIFY_STORE}/admin/api/${apiVersion(env)}/graphql.json`;

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

export function pickVisit(s, mode) {
  if (mode === 'first') return s.firstVisit || s.lastVisit || null;
  if (mode === 'last') return s.lastVisit || s.firstVisit || null;
  const visits = [...(s.moments?.nodes || []), s.firstVisit, s.lastVisit].filter((v) => v && v.landingPage);
  const tagged = visits.filter(isTaggedVisit).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  return tagged.length ? tagged[tagged.length - 1] : s.lastVisit || s.firstVisit || null;
}

// A failed Shopify call. transient = worth waiting and retrying (rate limit, 5xx, network);
// otherwise it's a setup problem (credentials, scopes, access) that waiting won't fix.
export class ShopifyError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient;
  }
}

const isTransientStatus = (status) => status === 429 || status >= 500;
const snippet = (text, n = 200) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Admin API token: either a static legacy token (SHOPIFY_ADMIN_TOKEN) or, for Dev Dashboard apps,
// exchanged from SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client credentials grant) and cached ~until expiry.
export async function getShopifyToken(env, forceRefresh = false) {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return null;
  if (!forceRefresh) {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'shopify_token'").first();
    if (row) {
      const { token, expiresAt } = JSON.parse(row.value);
      if (Date.now() < expiresAt) return token;
    }
  }
  let r;
  try {
    r = await fetch(`https://${env.SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
      }),
    });
  } catch (e) {
    throw new ShopifyError(`Shopify token request failed: ${e.message}`, { transient: true });
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!j?.access_token) {
    const detail = j?.error_description || j?.error || j?.errors || snippet(text);
    throw new ShopifyError(`Shopify token request failed (${r.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      { transient: isTransientStatus(r.status) });
  }
  const expiresAt = Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000; // refresh 5 min early
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('shopify_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ token: j.access_token, expiresAt })).run();
  console.log(`Got Shopify token (scopes: ${j.scope}, expires in ${j.expires_in}s)`);
  return j.access_token;
}

// One GraphQL call. Returns the parsed JSON body or throws a ShopifyError.
// On 401 with client credentials, gets a fresh token and tries once more.
export async function shopifyGraphql(env, query, variables) {
  let token = await getShopifyToken(env);
  if (!token) throw new ShopifyError('No Shopify credentials set (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)');
  for (let retried = false; ; retried = true) {
    let r;
    try {
      r = await fetch(graphqlEndpoint(env), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new ShopifyError(`Shopify request failed: ${e.message}`, { transient: true });
    }
    if (r.status === 401 && !retried && !env.SHOPIFY_ADMIN_TOKEN) {
      token = await getShopifyToken(env, true);
      continue;
    }
    const text = await r.text();
    if (!r.ok) {
      throw new ShopifyError(`Shopify API ${r.status}: ${snippet(text) || r.statusText}`, { transient: isTransientStatus(r.status) });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ShopifyError(`Shopify API returned non-JSON: ${snippet(text)}`, { transient: true });
    }
  }
}

const describeGraphqlErrors = (errors) =>
  (Array.isArray(errors) ? errors : [errors])
    .map((e) => [e?.extensions?.code, e?.message].filter(Boolean).join(': ') || JSON.stringify(e))
    .join('; ');

/**
 * Looks up the order's customer journey. Returns { ready, visit, error }.
 *   ready=true             → Shopify's journey is built; visit may be null (no visits recorded)
 *   ready=false, no error  → Shopify hasn't finished building it yet; try again later
 *   error                  → the lookup itself failed (ShopifyError; error.transient says whether waiting may help)
 */
export async function fetchJourney(order, env, attempts = 5) {
  if (!order.admin_graphql_api_id) return { ready: false, visit: null, error: new ShopifyError('order has no admin_graphql_api_id') };
  let query = JOURNEY_QUERY_FULL;
  let error = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const j = await shopifyGraphql(env, query, { id: order.admin_graphql_api_id });
      if (j.errors) {
        console.warn(`Journey query errors for ${order.name}:`, JSON.stringify(j.errors).slice(0, 500));
        if (query === JOURNEY_QUERY_FULL) { query = JOURNEY_QUERY_BASIC; attempt--; continue; } // retry with simpler query
        const throttled = [].concat(j.errors).some((e) => e?.extensions?.code === 'THROTTLED');
        throw new ShopifyError(`Shopify GraphQL error: ${snippet(describeGraphqlErrors(j.errors), 300)}`, { transient: throttled });
      }
      if (!j.data?.order) throw new ShopifyError(`Shopify returned no order for ${order.admin_graphql_api_id}`);
      const s = j.data.order.customerJourneySummary;
      if (s?.ready) {
        const v = pickVisit(s, env.ATTRIBUTION || 'last_non_direct');
        console.log(`Journey for ${order.name} (${env.ATTRIBUTION || 'last_non_direct'}): ${v ? v.landingPage : 'no visits recorded'}`);
        return { ready: true, visit: v, error: null };
      }
      error = null; // reached Shopify fine; the journey just isn't ready
    } catch (e) {
      error = e instanceof ShopifyError ? e : new ShopifyError(e.message, { transient: true });
      console.warn(`Journey lookup failed for ${order.name}: ${error.message}`);
      if (!error.transient) break; // credentials / access problem: retrying now won't help
    }
    if (attempt < attempts - 1) await new Promise((res) => setTimeout(res, 5000)); // journey data can lag the webhook
  }
  return { ready: false, visit: null, error };
}

// Slack footer text for a bell posted without Shopify's journey data, saying why.
export function fallbackMethodLabel(journey, maxWaitMinutes = 10) {
  if (journey.error) return `landing_site (Shopify lookup failed: ${snippet(journey.error.message, 300)})`;
  return `landing_site (Shopify visit data not ready after ${maxWaitMinutes} min; this post updates when it arrives)`;
}

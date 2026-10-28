// Parses a landing URL into: Landing Page, Source, Medium, Campaign, Content, Term (ad name)

export const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];
const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'];

// Shopify's order.landing_site is usually a relative path ("/pages/x?utm_source=...").
// Turn it into a full URL on the storefront domain so it can be clicked and QA'd.
export function buildFullUrl(landing, storefrontDomain) {
  if (!landing) return null;
  const s = String(landing).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  return `https://${storefrontDomain}${s.startsWith('/') ? '' : '/'}${s}`;
}

export function parseLandingUrl(fullUrl) {
  const out = { landingPage: null, utm: {}, clickIds: [] };
  if (!fullUrl) return out;
  let u;
  try {
    u = new URL(fullUrl);
  } catch {
    out.landingPage = fullUrl;
    return out;
  }
  out.landingPage = `${u.origin}${u.pathname}`;
  for (const k of UTM_KEYS) {
    const v = u.searchParams.get(`utm_${k}`);
    if (v) out.utm[k] = v;
  }
  for (const k of CLICK_ID_KEYS) if (u.searchParams.has(k)) out.clickIds.push(k);
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Resolve attribution for an order.
 * Prefers Shopify's customer-journey visit (if an Admin token is configured),
 * falls back to order.landing_site / order.referring_site from the webhook.
 */
export function resolveAttribution({ landingSite, referringSite, journeyVisit, storefrontDomain }) {
  let fullUrl;
  let referrer = referringSite || null;
  let method = 'landing_site';

  if (journeyVisit && journeyVisit.landingPage) {
    fullUrl = buildFullUrl(journeyVisit.landingPage, storefrontDomain);
    referrer = journeyVisit.referrerUrl || referrer;
    method = 'customer_journey';
  } else {
    fullUrl = buildFullUrl(landingSite, storefrontDomain);
  }

  const parsed = parseLandingUrl(fullUrl);
  const utm = { ...parsed.utm };
  const jUtm = journeyVisit?.utmParameters;
  if (jUtm) for (const k of UTM_KEYS) if (!utm[k] && jUtm[k]) utm[k] = jUtm[k];

  let source = utm.source || null;
  let medium = utm.medium || null;
  let inferred = false;

  if (!source) {
    inferred = true;
    const refHost = hostOf(referrer);
    const selfHost = String(storefrontDomain || '').replace(/^www\./, '');
    const isSelf = refHost && (refHost === selfHost || refHost.endsWith('.' + selfHost) || refHost.endsWith('myshopify.com'));
    if (refHost && !isSelf) {
      source = refHost;
      medium = medium || 'referral';
    } else {
      source = '(direct)';
      medium = medium || '(none)';
    }
  }

  return {
    landingPage: parsed.landingPage,
    fullUrl,
    source,
    medium: medium || '(not set)',
    campaign: utm.campaign || null,
    content: utm.content || null,
    term: utm.term || null, // = ad name
    referrer,
    clickIds: parsed.clickIds,
    inferred,
    method,
  };
}

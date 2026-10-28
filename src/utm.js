// Parses a landing URL into: Landing Page, Source, Medium, Campaign, Content, Term (ad name)

export const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];
const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid', 'srsltid', 'fbclid', 'ttclid', 'msclkid'];

// When a visit has no UTMs, infer source/medium from click IDs first, then the referrer.
const CLICK_ID_RULES = [
  [['gclid', 'gbraid', 'wbraid'], 'google', 'cpc'],
  [['srsltid'], 'google', 'organic-shopping'], // Google Merchant Center free listings / organic product results
  [['msclkid'], 'bing', 'cpc'],
  [['ttclid'], 'tiktok', 'paid-social'],
  [['fbclid'], 'facebook', 'social'],
];
const SEARCH_ENGINES = { google: 'google', bing: 'bing', duckduckgo: 'duckduckgo', yahoo: 'yahoo', ecosia: 'ecosia', baidu: 'baidu', yandex: 'yandex' };
const SOCIAL = { facebook: 'facebook', instagram: 'instagram', tiktok: 'tiktok', pinterest: 'pinterest', 't.co': 'twitter', 'x.com': 'twitter', twitter: 'twitter', reddit: 'reddit', youtube: 'youtube', linkedin: 'linkedin', snapchat: 'snapchat' };

function classifyReferrer(host) {
  for (const [k, name] of Object.entries(SEARCH_ENGINES)) if (host.split('.').includes(k)) return [name, 'organic'];
  for (const [k, name] of Object.entries(SOCIAL)) if (host === k || host.endsWith('.' + k) || host.split('.').includes(k)) return [name, 'social'];
  return [host, 'referral'];
}

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

  // Shopify's journey often stores the landing page without its query string. If its UTMs
  // aren't in the URL, rebuild a QA link from them so the full link is still visible.
  let urlRebuilt = false;
  if (jUtm && fullUrl && !Object.keys(parsed.utm).length && UTM_KEYS.some((k) => jUtm[k])) {
    const u = new URL(fullUrl);
    for (const k of ['source', 'medium', 'campaign', 'term', 'content']) if (jUtm[k]) u.searchParams.set(`utm_${k}`, jUtm[k]);
    fullUrl = u.toString();
    urlRebuilt = true;
  }

  let source = utm.source || null;
  let medium = utm.medium || null;
  let inferred = false;
  let inferredFrom = null; // 'click_id' | 'referrer' | 'direct' | 'no_visit_data'

  if (!source) {
    inferred = true;
    const refHost = hostOf(referrer);
    const selfHost = String(storefrontDomain || '').replace(/^www\./, '');
    const isSelf = refHost && (refHost === selfHost || refHost.endsWith('.' + selfHost) || refHost.endsWith('myshopify.com'));
    const rule = CLICK_ID_RULES.find(([keys]) => keys.some((k) => parsed.clickIds.includes(k)));
    if (rule) {
      [, source] = rule;
      medium = medium || rule[2];
      inferredFrom = 'click_id';
    } else if (refHost && !isSelf) {
      const [src, med] = classifyReferrer(refHost);
      source = src;
      medium = medium || med;
      inferredFrom = 'referrer';
    } else if (!fullUrl && !referrer) {
      source = '(unknown)';
      medium = medium || '(no visit data)';
      inferredFrom = 'no_visit_data';
    } else {
      source = '(direct)';
      medium = medium || '(none)';
      inferredFrom = 'direct';
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
    inferredFrom,
    urlRebuilt,
    method,
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttribution } from '../src/utm.js';
import { periodStarts } from '../src/dashboard.js';

const EXAMPLE = 'https://drinkbrightside.com/pages/smitten-with-the-small-stuff?&utm_source=meta&utm_medium=paid-social&utm_campaign=sales-excl-customers&utm_term=smitten-if-your-vibe-cali-7s&utm_content=sales-LAL-customers';

test('parses the example link exactly as specified', () => {
  const a = resolveAttribution({ landingSite: EXAMPLE, storefrontDomain: 'drinkbrightside.com' });
  assert.equal(a.landingPage, 'https://drinkbrightside.com/pages/smitten-with-the-small-stuff');
  assert.equal(a.source, 'meta');
  assert.equal(a.medium, 'paid-social');
  assert.equal(a.campaign, 'sales-excl-customers');
  assert.equal(a.content, 'sales-LAL-customers');
  assert.equal(a.term, 'smitten-if-your-vibe-cali-7s');
  assert.equal(a.fullUrl, EXAMPLE);
});

test('handles Shopify relative landing_site', () => {
  const rel = EXAMPLE.replace('https://drinkbrightside.com', '');
  const a = resolveAttribution({ landingSite: rel, storefrontDomain: 'drinkbrightside.com' });
  assert.equal(a.fullUrl, EXAMPLE);
  assert.equal(a.source, 'meta');
});

test('no UTM → referrer or direct', () => {
  const r = resolveAttribution({ landingSite: '/', referringSite: 'https://www.google.com/', storefrontDomain: 'drinkbrightside.com' });
  assert.deepEqual([r.source, r.medium, r.inferred], ['google', 'organic', true]);
  const d = resolveAttribution({ landingSite: '/products/x', storefrontDomain: 'drinkbrightside.com' });
  assert.deepEqual([d.source, d.medium], ['(direct)', '(none)']);
});

test('journey UTMs are used when provided', () => {
  const a = resolveAttribution({
    landingSite: '/',
    journeyVisit: { landingPage: EXAMPLE, referrerUrl: null, utmParameters: { source: 'meta', medium: 'paid-social' } },
    storefrontDomain: 'drinkbrightside.com',
  });
  assert.equal(a.method, 'customer_journey');
  assert.equal(a.term, 'smitten-if-your-vibe-cali-7s');
});

test('week/month starts (Mon start)', () => {
  const s = periodStarts(new Date('2026-09-27T20:00:00Z'), 'America/New_York', 1); // Sunday
  assert.equal(s.monthStart, '2026-09-01');
  assert.equal(s.weekStart, '2026-09-21');
});

test('srsltid → google organic-shopping', () => {
  const a = resolveAttribution({ landingSite: 'https://drinkbrightside.com/?srsltid=AU7gw4W2gvEnfkUVtpRqZA6kQKNeQG9a', storefrontDomain: 'drinkbrightside.com' });
  assert.deepEqual([a.source, a.medium, a.inferredFrom, a.landingPage], ['google', 'organic-shopping', 'click_id', 'https://drinkbrightside.com/']);
});

test('no visit data → unknown, not direct', () => {
  const a = resolveAttribution({ landingSite: null, referringSite: null, storefrontDomain: 'drinkbrightside.com' });
  assert.deepEqual([a.source, a.medium], ['(unknown)', '(no visit data)']);
});

test('google referrer with no UTM → organic', () => {
  const a = resolveAttribution({ landingSite: '/', referringSite: 'https://www.google.com/', storefrontDomain: 'drinkbrightside.com' });
  assert.deepEqual([a.source, a.medium], ['google', 'organic']);
});

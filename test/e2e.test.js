import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, sqliteAvailable, order, ready } from './support/fake-world.js';

const skip = !sqliteAvailable && 'needs Node 22.5+ (node:sqlite)';
const realConsole = { ...console };
beforeEach(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
process.on('exit', () => Object.assign(console, realConsole));

test('journey ready at webhook time → one bell with customer_journey', { skip }, async () => {
  const w = await createWorld();
  w.journeys.set('gid://shopify/Order/1', ready());
  await w.webhook(order(1));
  assert.equal(w.slackPosts.length, 1);
  assert.match(w.footer(w.slackPosts[0]), /attribution: customer_journey/);
  assert.equal(w.row(1).source, 'meta');
  assert.equal(w.sheet.get('1').source, 'meta');
});

test('late journey → bell at 10 min, then the post, row and sheet are corrected', { skip }, async () => {
  const w = await createWorld();
  await w.webhook(order(2, 11));
  assert.equal(w.slackPosts.length, 0, 'held while waiting');
  await w.tick();
  assert.equal(w.slackPosts.length, 1);
  assert.match(w.footer(w.slackPosts[0]), /not ready after 10 min; this post updates/);

  w.journeys.set('gid://shopify/Order/2', ready());
  await w.tick();
  assert.match(w.footer(w.slackPosts[0]), /attribution: customer_journey .*Attribution updated/);
  assert.equal(w.row(2).attribution_method, 'customer_journey');
  assert.equal(w.sheet.get('2').source, 'meta');
});

test('webhook retry → one post', { skip }, async () => {
  const w = await createWorld();
  w.journeys.set('gid://shopify/Order/3', ready());
  await w.webhook(order(3));
  await w.webhook(order(3));
  assert.equal(w.slackPosts.length, 1);
});

test('Shopify setup error → posts at once with the error, recheck stops', { skip }, async () => {
  const w = await createWorld();
  w.journeys.set('gid://shopify/Order/4', () => new Response('[API] Access denied', { status: 403 }));
  await w.webhook(order(4));
  assert.match(w.footer(w.slackPosts[0]), /Shopify lookup failed: Shopify API 403/);
  assert.match(await w.admin('/admin/recheck?days=3'), /Stopped early/);
});

test('test orders are posted but never stored', { skip }, async () => {
  const w = await createWorld();
  await w.admin('/admin/test');
  await w.webhook(order(5, 0, { test: true }));
  assert.equal(w.slackPosts.length, 2);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('canvas update fails after the bell → no duplicate bell posts', { skip }, async () => {
  const w = await createWorld();
  w.db.raw.prepare("INSERT INTO meta (key, value) VALUES ('canvas_id', 'F1')").run();
  w.slackFail['canvases.edit'] = 'ratelimited';
  w.journeys.set('gid://shopify/Order/6', ready());
  await w.webhook(order(6));
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(w.slackPosts.length, 1);
  assert.equal(w.row(6).slack_ts, w.slackPosts[0].ts);
});

test('malformed landing page from Shopify still rings the bell', { skip }, async () => {
  const w = await createWorld();
  w.journeys.set('gid://shopify/Order/7', ready({ landingPage: 'https://', referrerUrl: null, utmParameters: { source: 'meta', medium: 'paid-social' } }));
  await w.webhook(order(7));
  assert.equal(w.slackPosts.length, 1);
  assert.equal(w.row(7).source, 'meta');
});

test('fix-slack ?all=1 works through more than 30 posts', { skip }, async () => {
  const w = await createWorld();
  for (let id = 100; id < 135; id++) { w.journeys.set(`gid://shopify/Order/${id}`, ready()); await w.webhook(order(id)); }
  const first = await w.admin('/admin/fix-slack?days=3&all=1');
  assert.match(first, /Edited 30/);
  const next = /offset=(\d+)/.exec(first);
  assert.ok(next, first);
  const second = await w.admin(`/admin/fix-slack?days=3&all=1&offset=${next[1]}`);
  assert.match(second, /Edited 5[\s\S]*All done/);
  assert.equal(new Set(w.slackEdits).size, 35);
});

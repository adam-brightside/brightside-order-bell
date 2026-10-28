// Slack Web API helper + the "bell" order message

export async function slackApi(method, params, env) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Slack ${method} failed: ${data.error}`);
    err.slackError = data.error;
    throw err;
  }
  return data;
}

// Slack mrkdwn requires &, <, > to be escaped
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function money(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);
}

export function prettyDate(iso, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

function inferredNote(attr) {
  if (!attr.inferred) return '';
  const notes = {
    click_id: `no UTM — inferred from click ID (${attr.clickIds.join(', ')})`,
    referrer: 'no UTM — inferred from referrer',
    direct: 'no UTM and no outside referrer',
    no_visit_data: 'Shopify sent no visit data for this order',
  };
  return `  _(${notes[attr.inferredFrom] || 'inferred'})_`;
}

export function buildOrderMessage(rec, attr, env, { isTest = false, editedNote = null } = {}) {
  const tz = env.STORE_TIMEZONE || 'America/New_York';
  const val = (v) => (v ? esc(v) : '_(not set)_');
  const adminUrl = `https://${env.SHOPIFY_STORE}/admin/orders/${rec.id}`;
  const total = money(rec.total_cents, rec.currency);
  const prefix = isTest ? '[TEST] ' : '';

  const attribution = [
    `*Landing Page* = ${attr.landingPage ? esc(attr.landingPage) : '_(unknown)_'}`,
    `*Source* = ${esc(attr.source)}${inferredNote(attr)}`,
    `*Medium* = ${val(attr.medium)}`,
    `*Campaign* = ${val(attr.campaign)}`,
    `*Content* = ${val(attr.content)}`,
    `*Term = Ad name* = ${val(attr.term)}`,
  ].join('\n');

  const items = rec.items.length ? rec.items.map((i) => `• ${esc(i)}`).join('\n') : '_(no line items)_';
  const fullUrl = attr.fullUrl ? esc(attr.fullUrl).slice(0, 2900) : '(no landing URL recorded)';
  const urlTitle = attr.urlRebuilt
    ? '*Full URL (for QA)*  _rebuilt from Shopify\'s UTM data — Shopify didn\'t keep the original link_'
    : '*Full URL (for QA)*';

  const context = [`Placed ${prettyDate(rec.created_at, tz)}`, `attribution: ${esc(attr.method)}`];
  if (attr.referrer) context.push(`referrer: ${esc(attr.referrer).slice(0, 200)}`);
  if (attr.clickIds?.length) context.push(`click IDs: ${attr.clickIds.join(', ')}`);

  const blocks = [];
  if (env.BELL_GIF_URL) blocks.push({ type: 'image', image_url: env.BELL_GIF_URL, alt_text: 'Ding ding — new order!' });
  blocks.push(
    { type: 'section', text: { type: 'mrkdwn', text: `:bell: *${prefix}New online order <${adminUrl}|${esc(rec.name)}> — ${total}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: attribution } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Items*\n${items}`.slice(0, 2990) } },
    { type: 'section', text: { type: 'mrkdwn', text: `${urlTitle}\n\`\`\`${fullUrl}\`\`\`` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }] },
  );
  if (editedNote) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:pencil2: ${editedNote}` }] });

  return { text: `${prefix}New online order ${rec.name} — ${total} — ${attr.source} / ${attr.medium}`, blocks };
}

// Returns the Slack message timestamp (ts) so the post can be edited later.
export async function postOrderMessage(rec, attr, env, opts = {}) {
  const { text, blocks } = buildOrderMessage(rec, attr, env, opts);
  const r = await slackApi('chat.postMessage', {
    channel: env.SLACK_CHANNEL_ID, text, blocks, unfurl_links: false, unfurl_media: false,
  }, env);
  return r.ts;
}

export async function updateOrderMessage(ts, rec, attr, env, editedNote) {
  const { text, blocks } = buildOrderMessage(rec, attr, env, { editedNote });
  await slackApi('chat.update', { channel: env.SLACK_CHANNEL_ID, ts, text, blocks }, env);
}

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

export async function postOrderMessage(rec, attr, env, { isTest = false } = {}) {
  const tz = env.STORE_TIMEZONE || 'America/New_York';
  const val = (v) => (v ? esc(v) : '_(not set)_');
  const adminUrl = `https://${env.SHOPIFY_STORE}/admin/orders/${rec.id}`;
  const total = money(rec.total_cents, rec.currency);
  const prefix = isTest ? '[TEST] ' : '';

  const attribution = [
    `*Landing Page* = ${attr.landingPage ? esc(attr.landingPage) : '_(unknown)_'}`,
    `*Source* = ${esc(attr.source)}${attr.inferred ? '  _(no UTM on this visit — inferred from referrer)_' : ''}`,
    `*Medium* = ${val(attr.medium)}`,
    `*Campaign* = ${val(attr.campaign)}`,
    `*Content* = ${val(attr.content)}`,
    `*Term = Ad name* = ${val(attr.term)}`,
  ].join('\n');

  const items = rec.items.length ? rec.items.map((i) => `• ${esc(i)}`).join('\n') : '_(no line items)_';
  const fullUrl = attr.fullUrl ? esc(attr.fullUrl).slice(0, 2900) : '(no landing URL recorded)';

  const context = [`Placed ${prettyDate(rec.created_at, tz)}`, `attribution: ${attr.method}`];
  if (attr.referrer) context.push(`referrer: ${esc(attr.referrer).slice(0, 200)}`);
  if (attr.clickIds.length) context.push(`click IDs: ${attr.clickIds.join(', ')}`);

  const blocks = [];
  if (env.BELL_GIF_URL) blocks.push({ type: 'image', image_url: env.BELL_GIF_URL, alt_text: 'Ding ding — new order!' });
  blocks.push(
    { type: 'section', text: { type: 'mrkdwn', text: `:bell: *${prefix}New online order <${adminUrl}|${esc(rec.name)}> — ${total}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: attribution } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Items*\n${items}`.slice(0, 2990) } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Full URL (for QA)*\n\`\`\`${fullUrl}\`\`\`` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }] },
  );

  await slackApi('chat.postMessage', {
    channel: env.SLACK_CHANNEL_ID,
    text: `${prefix}New online order ${rec.name} — ${total} — ${attr.source} / ${attr.medium}`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  }, env);
}

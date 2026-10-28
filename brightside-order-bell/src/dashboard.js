// Builds the running tally (Lifetime / MTD / WTD) and writes it to the channel's
// canvas tab (default) or to a pinned message that gets edited in place.

import { slackApi, money, esc } from './slack.js';

export function localYmd(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// weekStart: 0 = Sunday, 1 = Monday
export function periodStarts(now, tz, weekStart = 1) {
  const today = localYmd(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const back = (t.getUTCDay() - weekStart + 7) % 7;
  t.setUTCDate(t.getUTCDate() - back);
  return { today, monthStart: `${today.slice(0, 7)}-01`, weekStart: t.toISOString().slice(0, 10) };
}

async function getMeta(env, key) {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value).run();
}

async function periodStats(env, since) {
  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE local_date >= ?',
  ).bind(since).first();
  const { results: bySource } = await env.DB.prepare(
    `SELECT source, medium, COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS cents
       FROM orders WHERE local_date >= ?
      GROUP BY source, medium ORDER BY n DESC, cents DESC LIMIT 15`,
  ).bind(since).all();
  return { n: totals.n, cents: totals.cents, bySource };
}

export async function getStats(env, recentLimit = 50) {
  const tz = env.STORE_TIMEZONE || 'America/New_York';
  const starts = periodStarts(new Date(), tz, Number(env.WEEK_START ?? 1));
  const [lifetime, mtd, wtd] = await Promise.all([
    periodStats(env, '0000-00-00'),
    periodStats(env, starts.monthStart),
    periodStats(env, starts.weekStart),
  ]);
  const { results: recent } = await env.DB.prepare(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT ?',
  ).bind(recentLimit).all();
  const first = await env.DB.prepare('SELECT MIN(local_date) AS d FROM orders').first();
  return { tz, starts, lifetime, mtd, wtd, recent, trackingSince: first?.d, currency: env.CURRENCY || 'USD' };
}

const fmtDay = (ymd) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ymd + 'T00:00:00Z'));

const orderLine = (o, cur, bold) => {
  const items = JSON.parse(o.items || '[]').join(', ');
  const b = (s) => (bold === 'md' ? `**${s}**` : `*${s}*`);
  const src = `${o.source} / ${o.medium}`;
  const extra = [o.campaign, o.term].filter(Boolean).join(' · ');
  return `${b(fmtDay(o.local_date))} · ${o.name} · ${money(o.total_cents, o.currency || cur)} · ${src}${extra ? ` (${extra})` : ''} — ${items}`;
};

// ---------- Canvas (standard markdown) ----------
export function renderCanvas(s) {
  const updated = new Intl.DateTimeFormat('en-US', { timeZone: s.tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  const period = (title, p) => [
    `## ${title}`,
    `**${p.n.toLocaleString()} orders · ${money(p.cents, s.currency)}**`,
    '',
    ...(p.bySource.length
      ? p.bySource.map((r) => `- ${r.source} / ${r.medium} — ${r.n} orders · ${money(r.cents, s.currency)}`)
      : ['- No orders yet']),
    '',
  ];
  return [
    '# 🛎️ Online Orders Tracker',
    `_Last updated ${updated} · tracking since ${s.trackingSince ? fmtDay(s.trackingSince) : 'first order'}_`,
    '',
    ...period(`Week to date (since ${fmtDay(s.starts.weekStart)})`, s.wtd),
    ...period(`Month to date (since ${fmtDay(s.starts.monthStart)})`, s.mtd),
    ...period('Lifetime', s.lifetime),
    `## Recent orders (latest ${s.recent.length})`,
    ...(s.recent.length ? s.recent.map((o) => `- ${orderLine(o, s.currency, 'md')}`) : ['- No orders yet']),
  ].join('\n');
}

// ---------- Pinned message (Slack mrkdwn) ----------
export function renderMessage(s) {
  const period = (title, p) =>
    [`*${title}:* ${p.n.toLocaleString()} orders · ${money(p.cents, s.currency)}`,
      ...p.bySource.slice(0, 8).map((r) => `   • ${esc(r.source)} / ${esc(r.medium)} — ${r.n} · ${money(r.cents, s.currency)}`)].join('\n');
  const sections = [
    ':bell: *Online Orders Tracker*',
    period(`WTD (since ${fmtDay(s.starts.weekStart)})`, s.wtd),
    period(`MTD (since ${fmtDay(s.starts.monthStart)})`, s.mtd),
    period('Lifetime', s.lifetime),
    '*Recent orders*\n' + s.recent.slice(0, 15).map((o) => `• ${esc(orderLine(o, s.currency, 'mrkdwn'))}`).join('\n'),
  ];
  return {
    text: `Orders — WTD ${s.wtd.n} · MTD ${s.mtd.n} · Lifetime ${s.lifetime.n}`,
    blocks: sections.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t.slice(0, 2990) } })),
  };
}

async function updateCanvas(markdown, env) {
  const content = { type: 'markdown', markdown };
  let id = env.SLACK_CANVAS_ID || (await getMeta(env, 'canvas_id'));
  if (!id) {
    try {
      const r = await slackApi('conversations.canvases.create', { channel_id: env.SLACK_CHANNEL_ID, document_content: content }, env);
      await setMeta(env, 'canvas_id', r.canvas_id);
      return;
    } catch (e) {
      if (e.slackError !== 'channel_canvas_already_exists') throw e;
      const info = await slackApi('conversations.info', { channel: env.SLACK_CHANNEL_ID }, env);
      id = info.channel?.properties?.canvas?.file_id;
      if (!id) throw new Error('Channel already has a canvas but its ID could not be found — set SLACK_CANVAS_ID.');
      await setMeta(env, 'canvas_id', id);
    }
  }
  await slackApi('canvases.edit', { canvas_id: id, changes: [{ operation: 'replace', document_content: content }] }, env);
}

async function updatePinned({ text, blocks }, env) {
  const channel = env.SLACK_CHANNEL_ID;
  const ts = await getMeta(env, 'dashboard_ts');
  if (ts) {
    try {
      await slackApi('chat.update', { channel, ts, text, blocks }, env);
      return;
    } catch (e) {
      if (e.slackError !== 'message_not_found') throw e;
    }
  }
  const r = await slackApi('chat.postMessage', { channel, text, blocks }, env);
  await setMeta(env, 'dashboard_ts', r.ts);
  await slackApi('pins.add', { channel, timestamp: r.ts }, env).catch((e) => console.warn('pin failed', e.message));
}

export async function refreshDashboard(env) {
  const stats = await getStats(env);
  if ((env.DASHBOARD_MODE || 'canvas') === 'canvas') await updateCanvas(renderCanvas(stats), env);
  else await updatePinned(renderMessage(stats), env);
}

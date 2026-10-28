// Sends stored orders to a Google Sheet via an Apps Script web app.
// The sheet script ignores order IDs it already has, so re-sending is always safe.

export function toSheetRow(r) {
  let items = r.items;
  try { items = JSON.parse(r.items || '[]').join('; '); } catch { /* already a string */ }
  return {
    id: String(r.id),
    name: r.name,
    date: r.local_date,
    created_at: r.created_at,
    total: (r.total_cents || 0) / 100,
    currency: r.currency,
    items,
    source: r.source,
    medium: r.medium,
    campaign: r.campaign || '',
    content: r.content || '',
    term: r.term || '',
    landing_page: r.landing_page || '',
    full_url: r.full_url || '',
    referrer: r.referrer || '',
    attribution: r.attribution_method || '',
  };
}

export async function sendToSheet(dbRows, env, { update = false } = {}) {
  if (!env.SHEETS_WEBHOOK_URL) return { ok: true, skipped: 'SHEETS_WEBHOOK_URL not set' };
  const res = await fetch(env.SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.SHEETS_SECRET, update, orders: dbRows.map(toSheetRow) }),
    redirect: 'follow', // Apps Script answers via a redirect
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Sheet web app returned non-JSON (check the Web app URL and "Anyone" access): ${text.slice(0, 200)}`);
  }
  if (!j.ok) throw new Error(`Sheet web app error: ${j.error}`);
  return j;
}

// Re-send orders from the database. sinceDays = null sends everything (backfill).
export async function syncSheet(env, sinceDays = 35) {
  let stmt;
  if (sinceDays == null) {
    stmt = env.DB.prepare('SELECT * FROM orders ORDER BY created_at ASC');
  } else {
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
    stmt = env.DB.prepare('SELECT * FROM orders WHERE created_at >= ? ORDER BY created_at ASC').bind(since);
  }
  const { results } = await stmt.all();
  return sendToSheet(results, env);
}

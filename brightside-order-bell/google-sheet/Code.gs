/**
 * Brightside Order Bell → Google Sheet receiver
 * Paste into the sheet's Extensions → Apps Script, set SECRET, run setup() once,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 */

const SECRET = 'PASTE_THE_SAME_VALUE_YOU_USE_FOR_SHEETS_SECRET';
const ORDERS = 'Orders';
const SUMMARY = 'Summary';
const HEADERS = [
  'Order ID', 'Order #', 'Date', 'Created (UTC)', 'Total', 'Currency', 'Items',
  'Source', 'Medium', 'Campaign', 'Content', 'Term (Ad name)',
  'Landing Page', 'Full URL', 'Referrer', 'Attribution',
];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad json' });
  }
  if (body.secret !== SECRET) return json_({ ok: false, error: 'unauthorized (SECRET mismatch)' });

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const sh = ordersSheet_();
    const last = sh.getLastRow();
    const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map((r) => String(r[0])) : [];
    const rowOf = new Map(ids.map((id, i) => [id, i + 2]));
    const rows = [];
    let updated = 0;
    (body.orders || []).forEach((o) => {
      const id = String(o.id);
      if (rowOf.has(id)) {
        if (body.update) { // overwrite the existing row with corrected data
          sh.getRange(rowOf.get(id), 1, 1, HEADERS.length).setValues([toRow_(o)]);
          updated++;
        }
        return;
      }
      rowOf.set(id, -1);
      rows.push(toRow_(o));
    });
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
      sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).sort({ column: 4, ascending: false }); // newest first
    }
    return json_({ ok: true, received: (body.orders || []).length, added: rows.length, updated });
  } finally {
    lock.releaseLock();
  }
}

function toRow_(o) {
  const [y, m, d] = String(o.date || '').split('-').map(Number);
  return [
    String(o.id), o.name || '', y ? `=DATE(${y},${m},${d})` : '', o.created_at || '',
    Number(o.total) || 0, o.currency || '', o.items || '',
    o.source || '', o.medium || '', o.campaign || '', o.content || '', o.term || '',
    o.landing_page || '', o.full_url || '', o.referrer || '', o.attribution || '',
  ];
}

function ordersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ORDERS);
  if (!sh) {
    sh = ss.insertSheet(ORDERS);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('C:C').setNumberFormat('yyyy-mm-dd');
    sh.getRange('E:E').setNumberFormat('$#,##0.00');
  }
  return sh;
}

/** Run once from the Apps Script editor (select "setup" → Run). Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ordersSheet_();

  let s = ss.getSheetByName(SUMMARY);
  if (!s) s = ss.insertSheet(SUMMARY, 0);
  s.clear();

  const wk = '(TODAY()-WEEKDAY(TODAY(),3))'; // Monday of this week
  const mo = '(EOMONTH(TODAY(),-1)+1)';      // 1st of this month
  const q = (since, groupCols, labels) => {
    const where = since ? `where C >= date '"&TEXT(${since},"yyyy-mm-dd")&"'` : 'where A is not null';
    const lab = labels.map(([c, l]) => `${c} '${l}'`).join(', ');
    return `=IFERROR(QUERY(${ORDERS}!A2:P, "select ${groupCols}, count(A), sum(E) ${where} group by ${groupCols} order by count(A) desc label ${lab}, count(A) 'Orders', sum(E) 'Revenue'", 0), "No orders yet")`;
  };
  const src = [['H', 'Source'], ['I', 'Medium']];

  s.getRange('A1').setValue('Online Orders Summary').setFontSize(14).setFontWeight('bold');
  s.getRange('A2').setFormula('="Updated live · today is "&TEXT(TODAY(),"ddd mmm d, yyyy")');
  s.getRange('A4:C4').setValues([['Period', 'Orders', 'Revenue']]).setFontWeight('bold');
  s.getRange('A5:C7').setFormulas([
    ['="Week to date (since "&TEXT(' + wk + ',"mmm d")&")"',
      `=COUNTIFS(${ORDERS}!C2:C,">="&${wk})`, `=SUMIFS(${ORDERS}!E2:E,${ORDERS}!C2:C,">="&${wk})`],
    ['="Month to date (since "&TEXT(' + mo + ',"mmm d")&")"',
      `=COUNTIFS(${ORDERS}!C2:C,">="&${mo})`, `=SUMIFS(${ORDERS}!E2:E,${ORDERS}!C2:C,">="&${mo})`],
    ['Lifetime', `=COUNTA(${ORDERS}!A2:A)`, `=SUM(${ORDERS}!E2:E)`],
  ]);
  s.getRange('C5:C7').setNumberFormat('$#,##0.00');

  const blocks = [
    ['A', 'By source — WTD', q(wk, 'H, I', src)],
    ['F', 'By source — MTD', q(mo, 'H, I', src)],
    ['K', 'By source — Lifetime', q(null, 'H, I', src)],
    ['P', 'By campaign & ad — Lifetime', q(null, 'J, L', [['J', 'Campaign'], ['L', 'Ad name (Term)']])],
  ];
  blocks.forEach(([col, title, f]) => {
    s.getRange(col + '10').setValue(title).setFontWeight('bold');
    s.getRange(col + '11').setFormula(f);
  });
  ['D', 'I', 'N', 'S'].forEach((c) => s.getRange(`${c}11:${c}`).setNumberFormat('$#,##0.00'));
  s.autoResizeColumns(1, 19);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

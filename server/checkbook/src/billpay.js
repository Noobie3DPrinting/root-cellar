// Bill Pay link — a faithful port of the previous checkbook's integration.
// Bill Pay is only used through its own API (GET /api/data, POST /api/pay); it is never modified.
const { db, meta, bumpRev } = require('./db');
const bills = require('./bills');

const BILLPAY_URL = (process.env.BILLPAY_URL || '').trim().replace(/\/+$/, '');
const BILLPAY_PIN = (process.env.BILLPAY_PIN || '').trim();
const SYNC_SECONDS = Math.max(5, Number(process.env.BILLPAY_SYNC_SECONDS || 20));
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const BP = { data: null, at: 0, error: null, lastOk: null };
// 'builtin' = bills live in this app; 'external' = talk to the old Bill Pay app; '' = off
const mode = () => bills.enabled() ? 'builtin' : (BILLPAY_URL ? 'external' : '');
const isOn = () => mode() !== '';
let syncing = Promise.resolve(); // one Bill Pay conversation at a time

// ---------- local dates ----------
const pad = n => String(n).padStart(2, '0');
function localDateParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const localToday = () => localDateParts();
const nowIso = () => new Date().toISOString().slice(0, 19);
const isoToDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const dateToIso = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => dateToIso(new Date(isoToDate(iso).getTime() + n * 86400000));
const dayDiff = (a, b) => Math.round((isoToDate(a) - isoToDate(b)) / 86400000);
function atToLocalDate(at) {
  if (!at) return localToday();
  const d = new Date(String(at));
  if (isNaN(d)) return localToday();
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(at))) return String(at).slice(0, 10); // naive -> as written
  return localDateParts(d);
}
function monthAdd(month, k) { const [y, m] = month.split('-').map(Number); const i = y * 12 + m - 1 + k; return `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`; }
function dueDate(bill, month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let d = parseInt(bill.due, 10); if (!Number.isFinite(d)) d = 1;
  return `${y}-${pad(m)}-${pad(Math.max(1, Math.min(d, last)))}`;
}
const monthLabel = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const monthShort = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// ---------- helpers ----------
const toCents = v => { if (v == null || v === '') return 0; if (typeof v === 'number') return Math.round(v * 100); const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const billActive = (bill, month) => ((bill.status || 'Active') === 'Active') && (!bill.ends || bill.ends >= month);
const billLabel = bill => (bill.name || 'Bill') + (bill.item ? ` – ${bill.item}` : '');
const words = s => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
function nameMatch(payee, bill) {
  const p = words(payee).join(' ');
  if (p.length < 3) return false;
  for (const cand of [bill.name, billLabel(bill)]) {
    const b = words(cand).join(' ');
    if (b.length >= 3 && (p.includes(b) || b.includes(p))) return true;
  }
  const pw = words(payee), bw = words(bill.name);
  return pw.length > 0 && bw.length > 0 && pw[0] === bw[0] && pw[0].length >= 4;
}
const paymentsOf = data => { const out = new Map(); for (const [m, ps] of Object.entries(data.months || {})) for (const [b, p] of Object.entries(ps || {})) if (p && typeof p === 'object') out.set(`${m}|${b}`, { month: m, bill_id: b, ...p }); return out; };
function linkAccount() {
  const v = meta.get('bp_account');
  if (v && db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(Number(v))) return Number(v);
  const r = db.prepare('SELECT id FROM accounts WHERE archived = 0 ORDER BY id LIMIT 1').get();
  return r ? r.id : null;
}
function whoKey(data, name) {
  const names = (data.settings || {}).names || {};
  for (const [k, v] of Object.entries(names)) if (name && String(v).trim().toLowerCase() === name.trim().toLowerCase()) return k;
  return null;
}

// ---------- HTTP ----------
async function bpRequest(path, body) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(BILLPAY_URL + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-Pin': BILLPAY_PIN }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`Bill Pay answered ${r.status}`);
    const txt = await r.text(); return txt ? JSON.parse(txt) : {};
  } finally { clearTimeout(t); }
}
const bpRemember = data => { BP.data = data; BP.at = Date.now(); BP.error = null; BP.lastOk = Date.now(); };
async function bpFetch() {
  if (mode() === 'builtin') { const data = bills.getData(); bpRemember(data); return data; }
  try { const data = await bpRequest('/api/data'); bpRemember(data); return data; }
  catch (e) { BP.error = `Can't reach Bill Pay at ${BILLPAY_URL} (${e.name === 'AbortError' ? 'timeout' : e.message})`; throw e; }
}
async function bpData(maxAge = 20000) { if (mode() === 'builtin') return bpFetch(); if (BP.data && Date.now() - BP.at < maxAge) return BP.data; return bpFetch(); }
async function bpPostPay(month, billId, amountCents, by, at) {
  const payment = amountCents == null ? null : { amount: Math.round(amountCents) / 100, by: by || null, at: at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  if (mode() === 'builtin') { bills.setPayment(month, billId, payment && { amount_cents: Math.round(amountCents), by: payment.by, at: payment.at }); return { ok: true, data: bills.getData() }; }
  const res = await bpRequest('/api/pay', { month, bill: billId, payment });
  if (res && typeof res.data === 'object' && res.data) bpRemember(res.data);
  return res;
}

// ---------- statements ----------
const q = {
  linksAll: db.prepare('SELECT * FROM bill_links'),
  linkGet: db.prepare('SELECT * FROM bill_links WHERE month = ? AND bill_id = ?'),
  linkByTx: db.prepare(`SELECT * FROM bill_links WHERE tx_id = ? AND state = 'linked'`),
  linkPut: db.prepare('INSERT OR REPLACE INTO bill_links (month, bill_id, tx_id, amount_cents, state) VALUES (?, ?, ?, ?, ?)'),
  linkPre: db.prepare(`INSERT OR IGNORE INTO bill_links (month, bill_id, tx_id, amount_cents, state) VALUES (?, ?, NULL, ?, 'pre')`),
  linkDel: db.prepare('DELETE FROM bill_links WHERE month = ? AND bill_id = ?'),
  linkState: db.prepare('UPDATE bill_links SET state = ? WHERE month = ? AND bill_id = ?'),
  linkAmt: db.prepare('UPDATE bill_links SET amount_cents = ? WHERE month = ? AND bill_id = ?'),
  tx: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  txIns: db.prepare(`INSERT INTO transactions (account_id, date, payee, category, memo, amount, check_no, status, entered_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)`),
  txAmt: db.prepare(`UPDATE transactions SET amount = ?, updated_at = ? WHERE id = ?`),
  txDel: db.prepare('DELETE FROM transactions WHERE id = ?'),
  dup: db.prepare(`SELECT t.id, t.payee FROM transactions t WHERE t.account_id = ? AND t.amount = ? AND t.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM bill_links l WHERE l.tx_id = t.id AND l.state = 'linked') ORDER BY ABS(julianday(t.date) - julianday(?))`)
};

function findDup(acct, bill, cents, d) {
  for (const r of q.dup.all(acct, -cents, addDays(d, -7), addDays(d, 7), d)) if (nameMatch(r.payee, bill)) return r.id;
  return null;
}

// ---------- sync ----------
function withLock(fn) { const p = syncing.then(fn, fn); syncing = p.catch(() => {}); return p; }

async function bpSync() {
  if (!isOn()) return;
  return withLock(async () => {
    let data; try { data = await bpFetch(); } catch { return; }
    const pays = paymentsOf(data), bills = data.bills || {}, names = (data.settings || {}).names || {};
    let changed = false;
    let autopayOn = false, init = null;
    db.transaction(() => {
      const acct = linkAccount(); if (acct == null) return;
      if (meta.get('bp_init') == null) {
        // First connection: everything already paid is history -> don't copy it into the checkbook.
        for (const p of pays.values()) q.linkPre.run(p.month, p.bill_id, toCents(p.amount));
        meta.set('bp_init', localToday()); changed = true;
      }
      const links = new Map(q.linksAll.all().map(r => [`${r.month}|${r.bill_id}`, r]));
      for (const [key, p] of pays) {
        const { month: m, bill_id: bid } = p; const bill = bills[bid] || { name: bid }; const cents = toCents(p.amount);
        const L = links.get(key);
        if (!L || L.state === 'auto') {
          const d = atToLocalDate(p.at);
          let txid = cents ? findDup(acct, bill, cents, d) : null;
          if (txid == null && cents) {
            let memo = 'From Bill Pay' + (L ? ' · autopay' : '');
            if (m !== d.slice(0, 7)) memo += ` · for ${monthShort(m)}`;
            const ts = nowIso();
            txid = q.txIns.run(acct, d, billLabel(bill).slice(0, 120), String(bill.category || 'Bills').slice(0, 60), memo, -cents,
              String(names[p.by || ''] || (mode() === 'builtin' && p.by) || (L ? 'Autopay' : '')).slice(0, 40), ts, ts).lastInsertRowid;
          }
          q.linkPut.run(m, bid, txid, cents, 'linked'); changed = true;
        } else if (L.state === 'linked') {
          const tx = L.tx_id ? q.tx.get(L.tx_id) : null;
          if (!tx && L.tx_id) { q.linkState.run('dismissed', m, bid); changed = true; }
          else if (cents !== L.amount_cents) {
            if (!tx.status) q.txAmt.run(-cents, nowIso(), tx.id);
            q.linkAmt.run(cents, m, bid); changed = true;
          }
        }
      }
      for (const [key, L] of links) {
        if (pays.has(key)) continue;
        // Unchecked in Bill Pay: remove the entry it created (unless the bank already cleared it)
        if (L.state === 'linked' && L.tx_id) {
          const tx = q.tx.get(L.tx_id);
          if (tx && !tx.status && (tx.memo || '').startsWith('From Bill Pay')) q.txDel.run(L.tx_id);
        }
        q.linkDel.run(L.month, L.bill_id); changed = true;
      }
      if (changed) bumpRev();
      autopayOn = meta.get('bp_autopay', '1') === '1'; init = meta.get('bp_init');
    })();
    if (autopayOn && init) await bpAutopay(bills, pays, init);
  });
}

async function bpAutopay(bills, pays, since) {
  // Autopay bills mark themselves paid on their due date (only due dates after the link was turned on).
  const today = localToday(), month = today.slice(0, 7);
  let posted = false;
  for (const [bid, b] of Object.entries(bills)) {
    const amt = toCents(b.amount);
    if (b.autopay !== 'Yes' || !amt || !billActive(b, month) || pays.has(`${month}|${bid}`)) continue;
    const dd = dueDate(b, month);
    if (dd > today || dd < since) continue;
    if (q.linkGet.get(month, bid)) continue;
    q.linkPut.run(month, bid, null, amt, 'auto');
    try { await bpPostPay(month, bid, amt, null, `${dd}T12:00:00`); posted = true; }
    catch (e) { console.log(`[billpay] autopay post failed for ${bid}: ${e.message}`); db.prepare(`DELETE FROM bill_links WHERE month = ? AND bill_id = ? AND state = 'auto'`).run(month, bid); }
  }
  if (posted) await bpSyncInner();
}
// re-entrant sync used from inside the lock
async function bpSyncInner() {
  let data; try { data = await bpFetch(); } catch { return; }
  const pays = paymentsOf(data), bills = data.bills || {}, names = (data.settings || {}).names || {};
  db.transaction(() => {
    const acct = linkAccount(); if (acct == null) return;
    const links = new Map(q.linksAll.all().map(r => [`${r.month}|${r.bill_id}`, r]));
    for (const [key, p] of pays) {
      const L = links.get(key); if (L && L.state !== 'auto') continue;
      const bill = bills[p.bill_id] || { name: p.bill_id }, cents = toCents(p.amount), d = atToLocalDate(p.at);
      let txid = cents ? findDup(acct, bill, cents, d) : null;
      if (txid == null && cents) { const ts = nowIso(); txid = q.txIns.run(acct, d, billLabel(bill).slice(0, 120), String(bill.category || 'Bills').slice(0, 60), 'From Bill Pay' + (L ? ' · autopay' : ''), -cents, String(names[p.by || ''] || (mode() === 'builtin' && p.by) || (L ? 'Autopay' : '')).slice(0, 40), ts, ts).lastInsertRowid; }
      q.linkPut.run(p.month, p.bill_id, txid, cents, 'linked');
    }
    bumpRev();
  })();
}

// Checkbook -> Bill Pay: mark the bill paid using this checkbook entry.
async function bpLinkTx(txId, billId, month) {
  if (!isOn()) throw new Error("Bills aren't turned on");
  return withLock(async () => {
    const data = await bpData(5000);
    const bill = (data.bills || {})[billId];
    if (!bill || !/^\d{4}-\d{2}$/.test(String(month))) throw new Error("That bill wasn't found in Bill Pay");
    const tx = q.tx.get(txId); if (!tx) throw new Error('Entry not found');
    if (tx.amount >= 0) throw new Error('Only a payment can be linked to a bill');
    const cents = -tx.amount;
    q.linkPut.run(month, billId, txId, cents, 'linked'); bumpRev();
    try { await bpPostPay(month, billId, cents, whoKey(data, tx.entered_by)); }
    catch { db.prepare('DELETE FROM bill_links WHERE month = ? AND bill_id = ? AND tx_id = ?').run(month, billId, txId); throw new Error("Saved here, but couldn't reach Bill Pay to mark it paid"); }
    return { ok: true, bill: billLabel(bill) };
  });
}

// A linked entry's amount was edited in the checkbook -> update the paid amount in Bill Pay.
async function bpPushAmount(txId) {
  if (!isOn()) return;
  return withLock(async () => {
    const L = q.linkByTx.get(txId), tx = q.tx.get(txId);
    if (!L || !tx || -tx.amount === L.amount_cents || tx.amount >= 0) return;
    try {
      const data = await bpData(5000);
      const p = paymentsOf(data).get(`${L.month}|${L.bill_id}`) || {};
      await bpPostPay(L.month, L.bill_id, -tx.amount, p.by, p.at);
      q.linkAmt.run(-tx.amount, L.month, L.bill_id);
    } catch (e) { console.log(`[billpay] amount update failed: ${e.message}`); }
  });
}

// After a payment is entered here: is it one of the unpaid bills in Bill Pay?
async function suggestBill(tx) {
  if (!isOn() || tx.amount >= 0) return null;
  let data; try { data = await bpData(); } catch { return null; }
  const pays = paymentsOf(data), linked = new Set(q.linksAll.all().map(r => `${r.month}|${r.bill_id}`));
  const d = tx.date, amt = -tx.amount, bills = data.bills || {};
  const pw = new Set(words(tx.payee));
  const nameCount = {};
  for (const b of Object.values(bills)) { const k = words(b.name).join(' '); nameCount[k] = (nameCount[k] || 0) + 1; }
  let best = null;
  for (const [bid, b] of Object.entries(bills)) {
    if (!nameMatch(tx.payee, b)) continue;
    const bc = toCents(b.amount), bw = words(b.name);
    const strong = bw.length > 0 && bw.every(w => pw.has(w));
    const shared = (nameCount[bw.join(' ')] || 0) > 1;
    let tol; if (!strong) tol = Math.max(bc * 0.02, 100); else if (shared) tol = Math.max(bc * 0.15, 100); else tol = null;
    if (bc && tol != null && Math.abs(bc - amt) > tol) continue;
    for (const k of [-1, 0, 1]) {
      const m = monthAdd(d.slice(0, 7), k);
      if (!billActive(b, m) || pays.has(`${m}|${bid}`) || linked.has(`${m}|${bid}`)) continue;
      const dd = dueDate(b, m), gap = dayDiff(dd, d);
      if (gap < -25 || gap > 20) continue;
      const score = [Math.abs(bc - amt), Math.abs(gap)];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { score, bid, m, b, dd };
    }
  }
  if (!best) return null;
  return { bill_id: best.bid, month: best.m, name: billLabel(best.b), due: best.dd, month_label: monthLabel(best.m), amount_cents: toCents(best.b.amount) };
}

// ---------- paydays (one per person; "safe to spend" runs to whichever comes first) ----------
function detectPaydays(acct) {
  const since = addDays(localToday(), -150);
  const groups = {};
  for (const r of db.prepare('SELECT date, payee, amount FROM transactions WHERE account_id = ? AND amount > 0 AND date >= ? ORDER BY date').all(acct, since)) {
    const k = words(r.payee).join(' '); if (k) (groups[k] = groups[k] || []).push(r);
  }
  const found = [];
  for (const rows of Object.values(groups)) {
    if (rows.length < 3) continue;
    const gaps = rows.slice(1).map((r, i) => dayDiff(r.date, rows[i].date)).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    const every = [7, 14, 28].find(e => Math.abs(med - e) <= 1);
    if (!every) continue;
    found.push({ total: rows.reduce((s, r) => s + r.amount, 0), anchor: rows[rows.length - 1].date, every, label: rows[rows.length - 1].payee.trim() });
  }
  return found.sort((a, b) => b.total - a.total).slice(0, 3).map(({ anchor, every, label }) => ({ anchor, every, label }));
}
function getPaydays() {
  const raw = meta.get('paydays');
  if (raw) { try { const l = JSON.parse(raw); if (Array.isArray(l)) return l; } catch {} }
  const a = meta.get('payday_anchor'); // older single-payday setting
  return a ? [{ anchor: a, every: Number(meta.get('payday_every') || 14), label: meta.get('payday_label', 'Payday') }] : [];
}
function setPaydays(list) {
  const clean = (list || []).map(p => ({ anchor: String(p.anchor || '').slice(0, 10), every: [7, 14, 28, 30].includes(Number(p.every)) ? Number(p.every) : 14, label: String(p.label || 'Payday').trim().slice(0, 40) || 'Payday', amount_cents: Math.max(0, Number.isInteger(p.amount_cents) ? p.amount_cents : toCents(p.amount)) || 0 })).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.anchor));
  meta.set('paydays', JSON.stringify(clean));
  ['payday_anchor', 'payday_every', 'payday_label'].forEach(k => meta.del(k));
  return clean;
}
function nextDate(p, today) {
  if (p.every === 30) { // monthly on the anchor's day
    const day = Number(p.anchor.slice(8, 10)); let [y, m] = today.split('-').map(Number);
    for (let i = 0; i < 3; i++) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const d = `${y}-${pad(m)}-${pad(Math.min(day, last))}`; if (d > today) return d; m++; if (m > 12) { m = 1; y++; } }
  }
  return p.anchor > today ? p.anchor : addDays(p.anchor, (Math.floor(dayDiff(today, p.anchor) / p.every) + 1) * p.every);
}
function paydayInfo(acct) {
  let list = getPaydays(), source = 'settings';
  if (!list.length) { list = detectPaydays(acct); source = 'auto'; if (!list.length) return null; }
  const today = localToday();
  const all = list.map(p => ({ ...p, date: nextDate(p, today) })).sort((a, b) => a.date.localeCompare(b.date));
  const first = all[0];
  return { date: first.date, every: first.every, label: first.label, source, anchor: first.anchor, all };
}

// ---------- expected paychecks ----------
// You can enter what a paycheck will be ahead of time; it is NOT counted as available until
// 5:00 AM local time on the payday, when it posts itself to the register as a normal deposit.
db.exec(`CREATE TABLE IF NOT EXISTS expected_deposits (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, date TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER, posted_tx_id INTEGER, skipped INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(label, date))`);
const POST_HOUR = Number(process.env.PAYDAY_POST_HOUR || 5);
const localHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
const ed = {
  get: db.prepare('SELECT * FROM expected_deposits WHERE label = ? AND date = ?'),
  put: db.prepare(`INSERT INTO expected_deposits (label, date, amount_cents, account_id, skipped) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(label, date) DO UPDATE SET amount_cents = excluded.amount_cents, account_id = excluded.account_id, skipped = 0, updated_at = datetime('now')`),
  skip: db.prepare(`INSERT INTO expected_deposits (label, date, amount_cents, account_id, skipped) VALUES (?, ?, 0, NULL, 1)
    ON CONFLICT(label, date) DO UPDATE SET skipped = 1, updated_at = datetime('now')`),
  due: db.prepare('SELECT * FROM expected_deposits WHERE posted_tx_id IS NULL AND skipped = 0 AND amount_cents > 0 AND date <= ?'),
  posted: db.prepare('UPDATE expected_deposits SET posted_tx_id = ? WHERE id = ?'),
  insTx: db.prepare(`INSERT INTO transactions (account_id, date, payee, category, memo, amount, check_no, status, entered_by, created_at, updated_at) VALUES (?, ?, ?, 'Income', 'Paycheck', ?, '', '', 'Payday', ?, ?)`)
};
function nextDates(p, today, horizonDays) {
  const out = []; let d = nextDate(p, today); const stop = addDays(today, horizonDays);
  while (d <= stop && out.length < 6) { out.push(d); d = nextDate({ ...p, anchor: d }, d); }
  return out;
}
function upcomingPaychecks(acct, horizonDays = 35) {
  const info = paydayInfo(acct); if (!info) return [];
  const today = localToday(), list = [];
  for (const p of info.all) {
    for (const date of nextDates(p, today, horizonDays)) {
      const row = ed.get.get(p.label, date);
      const amount = row ? row.amount_cents : (p.amount_cents || 0);
      list.push({ label: p.label, date, amount_cents: amount, entered: !!row && !row.skipped, skipped: !!(row && row.skipped), posted: !!(row && row.posted_tx_id), default_cents: p.amount_cents || 0, posts_at: `${date} ${pad(POST_HOUR)}:00` });
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}
function setExpected(label, date, amountCents, acct) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
  const row = ed.get.get(label, date);
  if (row && row.posted_tx_id) throw new Error('That paycheck already posted to the register — edit it there');
  if (amountCents == null) ed.skip.run(label, date); else ed.put.run(label, date, Math.max(0, Math.round(amountCents)), acct || null);
  bumpRev();
}
// Called every minute: post any expected paycheck whose payday has arrived (5 AM local or later).
function postDuePaychecks() {
  const today = localToday(), hour = localHour();
  for (const r of ed.due.all(today)) {
    if (r.date === today && hour < POST_HOUR) continue;
    const acct = (r.account_id && db.prepare('SELECT id FROM accounts WHERE id = ?').get(r.account_id)) ? r.account_id : linkAccount();
    if (!acct) continue;
    const ts = nowIso();
    const txid = ed.insTx.run(acct, r.date, r.label, r.amount_cents, ts, ts).lastInsertRowid;
    ed.posted.run(txid, r.id); bumpRev();
    console.log(`[payday] posted ${r.label} ${r.date} ${(r.amount_cents / 100).toFixed(2)}`);
  }
}

async function upcoming(acct, balanceCents) {
  const out = { enabled: isOn(), mode: mode(), ok: false, error: null, items: [], total_cents: 0, balance_cents: balanceCents || 0, payday: acct ? paydayInfo(acct) : null, link_account: linkAccount(), paychecks: acct ? upcomingPaychecks(acct) : [] };
  if (!isOn()) return out;
  let data; try { data = await bpData(); } catch { out.error = BP.error; return out; }
  out.ok = true;
  const pays = paymentsOf(data), today = localToday();
  const stop = out.payday ? out.payday.date : addDays(today, 14);
  const m0 = today.slice(0, 7);
  for (const [bid, b] of Object.entries(data.bills || {})) {
    const cents = toCents(b.amount); if (!cents) continue;
    for (const m of [m0, monthAdd(m0, 1)]) {
      if (!billActive(b, m) || pays.has(`${m}|${bid}`)) continue;
      const dd = dueDate(b, m); if (dd >= stop) continue;
      out.items.push({ bill_id: bid, month: m, name: billLabel(b), due: dd, amount_cents: cents, autopay: b.autopay === 'Yes', overdue: dd < today, category: b.category || '' });
    }
  }
  out.items.sort((a, b) => a.due.localeCompare(b.due) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  out.total_cents = out.items.reduce((s, x) => s + x.amount_cents, 0);
  out.safe_cents = out.balance_cents - out.total_cents;
  out.paychecks = upcomingPaychecks(acct);
  return out;
}

function linkSettings() {
  const acct = linkAccount();
  return {
    enabled: isOn(), mode: mode(), url: BILLPAY_URL, error: mode() === 'builtin' ? null : BP.error, last_ok: BP.lastOk ? new Date(BP.lastOk).toISOString() : null,
    account: acct, autopay: meta.get('bp_autopay', '1') === '1', payday: acct ? paydayInfo(acct) : null,
    payday_manual: getPaydays().length > 0, paydays: getPaydays(), since: meta.get('bp_init')
  };
}

function startSyncLoop() {
  setTimeout(postDuePaychecks, 5000); setInterval(postDuePaychecks, 60 * 1000);
  if (mode() === 'external') console.log(`Linked to Bill Pay at ${BILLPAY_URL} (sync every ${SYNC_SECONDS}s)`);
  if (mode() === 'builtin') console.log('Built-in bills on');
  const tick = () => bpSync().catch(e => console.log(`[billpay] sync error: ${e.message}`));
  setTimeout(tick, 2000);
  setInterval(tick, SYNC_SECONDS * 1000);
}

module.exports = { getPaydays, setPaydays, upcomingPaychecks, setExpected, postDuePaychecks, get enabled() { return isOn(); }, mode, bpSync, bpLinkTx, bpPushAmount, suggestBill, upcoming, linkSettings, linkAccount, startSyncLoop, localToday };

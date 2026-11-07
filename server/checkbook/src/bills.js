// Built-in bill tracker (the former stand-alone Bill Pay app, now inside the checkbook).
// Storage is SQLite; getData() presents it in the same shape the old Bill Pay API served,
// so the link logic in billpay.js works unchanged whether bills live here or in the old app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, meta, bumpRev, DATA_DIR } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  item TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL DEFAULT 'Household',
  category TEXT NOT NULL DEFAULT 'Other',
  due INTEGER NOT NULL DEFAULT 1,
  autopay INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  ends TEXT NOT NULL DEFAULT '',
  balance_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'Active',
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bill_payments (
  month TEXT NOT NULL,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  paid_by TEXT,
  paid_at TEXT,
  PRIMARY KEY (month, bill_id)
);
`);

const CATS = ['Housing', 'Utilities', 'Credit Card', 'Loan', 'Buy Now Pay Later', 'Subscription', 'Insurance', 'Other'];
const CAT_ALIASES = { 'buy now pay later': 'Buy Now Pay Later', 'bnpl': 'Buy Now Pay Later', 'credit card': 'Credit Card' };
const normCat = c => CAT_ALIASES[String(c || '').trim().toLowerCase()] || (CATS.includes(c) ? c : 'Other');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const toCents = v => { if (v == null || v === '') return 0; if (typeof v === 'number') return Math.round(v * 100); const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const text = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);

// One-time tidy-ups of existing data (safe to run every start)
db.prepare(`UPDATE bills SET category = 'Buy Now Pay Later' WHERE category = 'Buy now pay later'`).run();
db.prepare(`UPDATE bills SET category = 'Credit Card' WHERE category = 'Credit card'`).run();
if (!meta.get('tidy_bnpl_v1')) {
  db.prepare(`UPDATE transactions SET category = 'Buy Now Pay Later' WHERE (payee LIKE '%affirm%' OR payee LIKE '%klarna%') AND category != 'Buy Now Pay Later'`).run();
  meta.set('tidy_bnpl_v1', new Date().toISOString());
}

const enabled = () => meta.get('feature_bills', '0') === '1';
const setEnabled = on => meta.set('feature_bills', on ? '1' : '0');

const q = {
  all: db.prepare('SELECT * FROM bills ORDER BY sort_order, due, name'),
  get: db.prepare('SELECT * FROM bills WHERE id = ?'),
  upsert: db.prepare(`INSERT INTO bills (id, name, item, who, category, due, autopay, amount_cents, ends, balance_cents, status, note, sort_order)
    VALUES (@id, @name, @item, @who, @category, @due, @autopay, @amount_cents, @ends, @balance_cents, @status, @note, @sort_order)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, item=excluded.item, who=excluded.who, category=excluded.category, due=excluded.due, autopay=excluded.autopay,
      amount_cents=excluded.amount_cents, ends=excluded.ends, balance_cents=excluded.balance_cents, status=excluded.status, note=excluded.note, sort_order=excluded.sort_order, updated_at=datetime('now')`),
  del: db.prepare('DELETE FROM bills WHERE id = ?'),
  pays: db.prepare('SELECT * FROM bill_payments'),
  payGet: db.prepare('SELECT * FROM bill_payments WHERE month = ? AND bill_id = ?'),
  payPut: db.prepare('INSERT OR REPLACE INTO bill_payments (month, bill_id, amount_cents, paid_by, paid_at) VALUES (?, ?, ?, ?, ?)'),
  payDel: db.prepare('DELETE FROM bill_payments WHERE month = ? AND bill_id = ?'),
  maxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM bills')
};

function cleanBill(b, existing) {
  const name = text(b.name, 80); if (!name) throw new Error('Give the bill a name');
  const due = parseInt(b.due, 10); if (!(due >= 1 && due <= 31)) throw new Error('Due day should be 1 to 31');
  let ends = text(b.ends, 7); if (ends && !MONTH_RE.test(ends)) ends = '';
  const balRaw = b.balance_cents !== undefined ? b.balance_cents : b.balance;
  return {
    id: existing ? existing.id : (ID_RE.test(String(b.id || '')) ? b.id : 'b' + crypto.randomBytes(5).toString('hex')),
    name, item: text(b.item), who: text(b.who, 40) || 'Household',
    category: normCat(b.category), due,
    autopay: (b.autopay === true || b.autopay === 'Yes' || b.autopay === 1) ? 1 : 0,
    amount_cents: Math.max(0, Number.isInteger(b.amount_cents) ? b.amount_cents : toCents(b.amount)),
    ends, balance_cents: (balRaw === null || balRaw === undefined || balRaw === '') ? null : Math.max(0, Number.isInteger(b.balance_cents) ? b.balance_cents : toCents(balRaw)),
    status: ['Active', 'Paid off', 'Paused'].includes(b.status) ? b.status : 'Active',
    note: text(b.note, 300),
    sort_order: Number.isInteger(b.sort_order) ? b.sort_order : existing ? existing.sort_order : q.maxOrder.get().n
  };
}

function saveBill(body, id) {
  const existing = id ? q.get.get(id) : null;
  if (id && !existing) throw new Error('That bill no longer exists');
  const merged = existing ? { ...existing, ...body } : { ...body };
  // A dollar value sent by the client replaces the stored cents, not the other way round
  if (body.amount !== undefined && body.amount_cents === undefined) delete merged.amount_cents;
  if (body.balance !== undefined && body.balance_cents === undefined) delete merged.balance_cents;
  const bill = cleanBill(merged, existing);
  q.upsert.run(bill); bumpRev();
  return q.get.get(bill.id);
}
function deleteBill(id) { q.del.run(id); db.prepare('DELETE FROM bill_links WHERE bill_id = ?').run(id); bumpRev(); }

// payment: { amount (dollars) | amount_cents, by, at } or null to unmark
function setPayment(month, billId, payment) {
  if (!MONTH_RE.test(String(month)) || !q.get.get(billId)) throw new Error('Bad month or bill');
  if (payment == null) q.payDel.run(month, billId);
  else q.payPut.run(month, billId, Number.isInteger(payment.amount_cents) ? payment.amount_cents : toCents(payment.amount), payment.by ? text(payment.by, 40) : null, text(payment.at, 30) || new Date().toISOString().slice(0, 19));
  bumpRev();
}

// Same shape as the old Bill Pay /api/data, so billpay.js can consume it directly.
function getData() {
  const users = db.prepare('SELECT display_name FROM users ORDER BY id').all().map(u => u.display_name);
  const names = { Household: 'Household' }; for (const u of users) names[u] = u;
  const bills = {};
  for (const b of q.all.all()) bills[b.id] = { id: b.id, name: b.name, item: b.item, who: b.who, category: b.category, due: b.due, autopay: b.autopay ? 'Yes' : 'No', amount: b.amount_cents / 100, amount_cents: b.amount_cents, ends: b.ends, balance: b.balance_cents == null ? null : b.balance_cents / 100, balance_cents: b.balance_cents, status: b.status, note: b.note, order: b.sort_order };
  const months = {};
  for (const p of q.pays.all()) (months[p.month] = months[p.month] || {})[p.bill_id] = { amount: p.amount_cents / 100, amount_cents: p.amount_cents, by: p.paid_by, at: p.paid_at };
  return { bills, months, settings: { names }, users };
}

// ---------- import / export (old Bill Pay JSON) ----------
function importJson(data, { replace = false } = {}) {
  if (!data || typeof data.bills !== 'object') throw new Error("That doesn't look like a Bill Pay data file");
  const names = (data.settings && data.settings.names) || {};
  const who = k => k === 'household' || !k ? 'Household' : (names[k] || k);
  let bills = 0, payments = 0;
  db.transaction(() => {
    if (replace) { db.exec('DELETE FROM bill_payments; DELETE FROM bills;'); }
    for (const [id, b] of Object.entries(data.bills)) {
      if (!ID_RE.test(id)) continue;
      q.upsert.run(cleanBill({ ...b, id, who: who(b.who), balance: b.balance, sort_order: Number.isInteger(b.order) ? b.order : undefined }, null)); bills++;
    }
    for (const [m, ps] of Object.entries(data.months || {})) {
      if (!MONTH_RE.test(m)) continue;
      for (const [bid, p] of Object.entries(ps || {})) {
        if (!q.get.get(bid) || !p || typeof p !== 'object') continue;
        q.payPut.run(m, bid, toCents(p.amount), p.by ? who(p.by) : null, p.at || null); payments++;
      }
    }
    // Payments the old checkbook already linked to register entries keep that link.
    bumpRev();
  })();
  return { bills, payments };
}
function exportJson() {
  const d = getData();
  const bills = {}; for (const [id, b] of Object.entries(d.bills)) bills[id] = { name: b.name, item: b.item, who: b.who, category: b.category, due: b.due, autopay: b.autopay, amount: b.amount, ends: b.ends, balance: b.balance, status: b.status, note: b.note, order: b.order };
  const months = {}; for (const [m, ps] of Object.entries(d.months)) { months[m] = {}; for (const [id, p] of Object.entries(ps)) months[m][id] = { amount: p.amount, by: p.by, at: p.at }; }
  return { rev: 1, settings: { names: d.settings.names }, bills, months, savedAt: new Date().toISOString().slice(0, 19) };
}

// First start: pull in the old Bill Pay data file if it was dropped into the data folder.
function migrateLegacy() {
  const file = process.env.LEGACY_BILLPAY || path.join(DATA_DIR, 'billpay.json');
  if (meta.get('bills_migrated_from') || !fs.existsSync(file)) return null;
  if (db.prepare('SELECT COUNT(*) n FROM bills').get().n > 0) return null;
  const r = importJson(JSON.parse(fs.readFileSync(file, 'utf8')));
  meta.set('bills_migrated_from', file); meta.set('bills_migrated_at', new Date().toISOString());
  setEnabled(true);
  return r;
}

module.exports = { CATS, enabled, setEnabled, list: () => q.all.all(), get: id => q.get.get(id), saveBill, deleteBill, setPayment, getPayment: (m, b) => q.payGet.get(m, b), getData, importJson, exportJson, migrateLegacy };

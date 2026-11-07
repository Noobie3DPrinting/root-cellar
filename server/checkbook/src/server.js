const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, DB_PATH, DATA_DIR, meta, bumpRev, getRev } = require('./db');
const imp = require('./importer');
const bp = require('./billpay');
const bills = require('./bills');
const { migrateFrom } = require('./migrate');
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS || 30);

const PORT = Number(process.env.PORT || 8080);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 90);
// Installed apps (Windows / Android) sign in once and stay signed in for a year; the token lives on that device only.
const APP_SESSION_DAYS = Number(process.env.APP_SESSION_DAYS || 365);
// Origins the installed apps load their screens from. They are not websites; they only talk to this server.
const APP_ORIGINS = new Set(['app://checkbook', 'app://checkbook.local', 'https://checkbook.local', ...String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const COOKIE = 'cb_session';
const APP_VERSION = require('../package.json').version;

// First start where an older Checkbook database exists: pull its data in.
try { const m = migrateFrom(); if (!m.skipped) console.log('[migrate] imported from previous checkbook:', m); } catch (e) { console.error('[migrate] failed:', e.message); }
try { const m = bills.migrateLegacy(); if (m) console.log('[migrate] imported from Bill Pay:', m); } catch (e) { console.error('[migrate] bills import failed:', e.message); }

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// ---------- installed apps: cross-origin API access (token auth, no cookies) ----------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.has(origin) && req.path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});

// ---------- security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'");
  next();
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));
const isSecure = req => req.secure || req.headers['x-forwarded-proto'] === 'https';
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const toInt = v => { const n = Number(v); return Number.isInteger(n) ? n : null; };

const stmts = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  sessionGet: db.prepare(`SELECT s.token, s.user_id, s.expires_at FROM sessions s WHERE s.token = ? AND s.expires_at > datetime('now')`),
  sessionInsert: db.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)'),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE token = ?'),
  accountsAll: db.prepare(`
    SELECT a.*,
      a.starting_balance + COALESCE(SUM(t.amount), 0) AS balance,
      a.starting_balance + COALESCE(SUM(CASE WHEN t.status IN ('cleared','reconciled') THEN t.amount ELSE 0 END), 0) AS cleared_balance,
      COUNT(t.id) AS tx_count
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id ORDER BY a.archived, a.sort_order, a.name`),
  accountGet: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  accountByName: db.prepare('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE'),
  accountInsert: db.prepare('INSERT INTO accounts (name, type, starting_balance, sort_order) VALUES (?, ?, ?, ?)'),
  txGet: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  txInsert: db.prepare(`INSERT INTO transactions (account_id, date, payee, category, memo, amount, check_no, status, transfer_id, import_batch_id, created_by, entered_by, uid)
    VALUES (@account_id, @date, @payee, @category, @memo, @amount, @check_no, @status, @transfer_id, @import_batch_id, @created_by, @entered_by, @uid)`),
  txUpdate: db.prepare(`UPDATE transactions SET account_id=@account_id, date=@date, payee=@payee, category=@category, memo=@memo, amount=@amount,
    check_no=@check_no, status=@status, updated_by=@entered_by, updated_at=datetime('now') WHERE id=@id`),
  txDelete: db.prepare('DELETE FROM transactions WHERE id = ?'),
  txDeleteTransfer: db.prepare('DELETE FROM transactions WHERE transfer_id = ?'),
  batchInsert: db.prepare('INSERT INTO import_batches (source, filename, user_id, row_count) VALUES (?, ?, ?, ?)'),
  batchGet: db.prepare('SELECT * FROM import_batches WHERE id = ?'),
  batchDeleteTx: db.prepare('DELETE FROM transactions WHERE import_batch_id = ?'),
  batchDelete: db.prepare('DELETE FROM import_batches WHERE id = ?')
};

// ---------- auth ----------
const loginAttempts = new Map(); // ip -> {count, until}
function rateLimited(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return false;
  if (e.until && Date.now() < e.until) return true;
  if (e.until && Date.now() >= e.until) loginAttempts.delete(ip);
  return false;
}
function recordFailure(ip) {
  const e = loginAttempts.get(ip) || { count: 0 };
  e.count++;
  if (e.count >= 8) { e.until = Date.now() + 15 * 60 * 1000; e.count = 0; }
  loginAttempts.set(ip, e);
}

function setSession(req, res, userId, forApp = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = forApp ? APP_SESSION_DAYS : SESSION_DAYS;
  const exp = new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const ua = forApp ? `App: ${String((req.body && req.body.device) || 'installed app').slice(0, 60)}` : (req.headers['user-agent'] || '');
  stmts.sessionInsert.run(token, userId, exp, ua.slice(0, 200));
  if (!forApp) res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`);
  return token;
}
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };

app.use((req, res, next) => {
  const token = bearer(req) || parseCookies(req)[COOKIE];
  if (token) {
    const s = stmts.sessionGet.get(token);
    if (s) { req.user = stmts.userById.get(s.user_id); req.sessionToken = token; }
  }
  next();
});
const requireAuth = (req, res, next) => req.user ? next() : fail(res, 401, 'Not signed in');
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : fail(res, 403, 'Admin only');

app.get('/api/status', (req, res) => {
  res.json({ needsSetup: stmts.userCount.get().n === 0, user: req.user || null, version: APP_VERSION, rev: getRev(), billpay: bp.enabled, billpay_mode: bp.mode(), bills: bills.enabled() });
});

app.get('/api/rev', (req, res) => res.json({ rev: getRev() }));

app.post('/api/setup', async (req, res) => {
  if (stmts.userCount.get().n > 0) return fail(res, 400, 'Already set up');
  const { username, display_name, password } = req.body || {};
  if (!username || !password || password.length < 8) return fail(res, 400, 'Username and a password of 8+ characters required');
  const hash = await bcrypt.hash(password, 12);
  const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)').run(username.trim(), (display_name || username).trim(), hash, 'admin');
  setSession(req, res, r.lastInsertRowid);
  res.json({ user: stmts.userById.get(r.lastInsertRowid) });
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
  const { username, password } = req.body || {};
  const u = username ? stmts.userByName.get(username.trim()) : null;
  const ok = u && await bcrypt.compare(password || '', u.password_hash);
  if (!ok) { recordFailure(ip); return fail(res, 401, 'Wrong username or password'); }
  loginAttempts.delete(ip);
  const forApp = !!(req.body && req.body.app);
  const token = setSession(req, res, u.id, forApp);
  res.json({ user: stmts.userById.get(u.id), ...(forApp ? { token } : {}) });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) stmts.sessionDelete.run(req.sessionToken); // works for cookie and app tokens
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { current, password } = req.body || {};
  const u = stmts.userByName.get(req.user.username);
  if (!(await bcrypt.compare(current || '', u.password_hash))) return fail(res, 400, 'Current password is wrong');
  if (!password || password.length < 8) return fail(res, 400, 'New password must be 8+ characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.sessionToken);
  res.json({ ok: true });
});

// ---------- users (admin) ----------
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id').all());
});
app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, display_name, password, role } = req.body || {};
  if (!username || !password || password.length < 8) return fail(res, 400, 'Username and a password of 8+ characters required');
  if (stmts.userByName.get(username.trim())) return fail(res, 400, 'Username already exists');
  const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username.trim(), (display_name || username).trim(), await bcrypt.hash(password, 12), role === 'admin' ? 'admin' : 'user');
  res.json(stmts.userById.get(r.lastInsertRowid));
});
app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = toInt(req.params.id); const u = stmts.userById.get(id);
  if (!u) return fail(res, 404, 'No such user');
  const { display_name, password, role } = req.body || {};
  if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), id);
  if (role && id !== req.user.id) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', id);
  if (password) {
    if (password.length < 8) return fail(res, 400, 'Password must be 8+ characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  res.json(stmts.userById.get(id));
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  if (id === req.user.id) return fail(res, 400, "You can't delete yourself");
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- accounts ----------
app.get('/api/accounts', requireAuth, (req, res) => res.json(stmts.accountsAll.all()));
app.post('/api/accounts', requireAuth, (req, res) => {
  const { name, type, starting_balance } = req.body || {};
  if (!name || !name.trim()) return fail(res, 400, 'Name required');
  const r = stmts.accountInsert.run(name.trim(), type || 'checking', Math.round(Number(starting_balance) || 0), db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM accounts').get().n);
  bumpRev();
  res.json(stmts.accountGet.get(r.lastInsertRowid));
});
app.patch('/api/accounts/:id', requireAuth, (req, res) => {
  const id = toInt(req.params.id); if (!stmts.accountGet.get(id)) return fail(res, 404, 'No such account');
  const { name, type, starting_balance, archived, sort_order } = req.body || {};
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(String(name).trim()); }
  if (type !== undefined) { sets.push('type = ?'); vals.push(String(type)); }
  if (starting_balance !== undefined) { sets.push('starting_balance = ?'); vals.push(Math.round(Number(starting_balance) || 0)); }
  if (archived !== undefined) { sets.push('archived = ?'); vals.push(archived ? 1 : 0); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(Number(sort_order) || 0); }
  if (sets.length) { db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id); bumpRev(); }
  res.json(stmts.accountGet.get(id));
});
app.delete('/api/accounts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(toInt(req.params.id)); bumpRev();
  res.json({ ok: true });
});

// ---------- transactions ----------
app.get('/api/transactions', requireAuth, (req, res) => {
  const { account, q, from, to, status, limit, offset, category } = req.query;
  const where = [], vals = [];
  if (account) { where.push('t.account_id = ?'); vals.push(toInt(account)); }
  if (from) { where.push('t.date >= ?'); vals.push(from); }
  if (to) { where.push('t.date <= ?'); vals.push(to); }
  if (status) { where.push('t.status = ?'); vals.push(status === 'open' ? '' : status); }
  if (category) { where.push('t.category = ?'); vals.push(category); }
  if (q) { where.push('(t.payee LIKE ? OR t.memo LIKE ? OR t.category LIKE ? OR t.check_no LIKE ?)'); const l = `%${q}%`; vals.push(l, l, l, l); }
  const sql = `SELECT t.*, u.display_name AS created_by_name, a.name AS account_name,
      (SELECT 1 FROM bill_links l WHERE l.tx_id = t.id AND l.state = 'linked') AS bill_linked
    FROM transactions t LEFT JOIN users u ON u.id = t.created_by JOIN accounts a ON a.id = t.account_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`;
  const lim = Math.min(Number(limit) || 200, 5000), off = Number(offset) || 0;
  const rows = db.prepare(sql).all(...vals, lim, off);
  // Running balance (only meaningful when filtered to a single account with no other filters)
  if (account && !q && !from && !to && !status && !category) {
    const acct = stmts.accountGet.get(toInt(account));
    // balance after the oldest row returned = starting + sum of everything older than it
    let running;
    if (rows.length) {
      const last = rows[rows.length - 1];
      const older = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id = ? AND (date < ? OR (date = ? AND id < ?))').get(acct.id, last.date, last.date, last.id).s;
      running = acct.starting_balance + older;
      for (let i = rows.length - 1; i >= 0; i--) { running += rows[i].amount; rows[i].balance = running; }
    }
  }
  res.json(rows);
});

function cleanTx(body, user) {
  const account_id = toInt(body.account_id);
  if (!account_id || !stmts.accountGet.get(account_id)) throw new Error('Pick an account');
  const date = imp.parseDate(body.date);
  if (!date) throw new Error('Date required');
  const amount = Number.isInteger(body.amount_cents) ? body.amount_cents : imp.parseAmount(body.amount);
  if (amount === null) throw new Error('Amount required');
  return {
    account_id, date, amount,
    payee: String(body.payee || '').trim().slice(0, 200),
    category: String(body.category || '').trim().slice(0, 100),
    memo: String(body.memo || '').trim().slice(0, 1000),
    check_no: String(body.check_no || '').trim().slice(0, 30),
    status: ['cleared', 'reconciled'].includes(body.status) ? body.status : '',
    transfer_id: null, import_batch_id: null, created_by: user.id, entered_by: user.display_name, uid: null
  };
}

const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;
app.post('/api/transactions', requireAuth, async (req, res) => {
  try {
    // The app sends its own permanent id; if this exact entry already arrived (a retry after a dropped connection), return it.
    const uid = UID_RE.test(String(req.body.uid || '')) ? String(req.body.uid) : null;
    if (uid) { const have = db.prepare('SELECT * FROM transactions WHERE uid = ?').get(uid); if (have) return res.json({ ...have, repeat: true }); }
    const t = cleanTx(req.body, req.user); t.uid = uid;
    const r = stmts.txInsert.run(t); bumpRev();
    const tx = stmts.txGet.get(r.lastInsertRowid);
    const out = { ...tx };
    const link = req.body.bill_link || {};
    if (link.bill_id && link.month) {
      try { out.linked = await bp.bpLinkTx(tx.id, String(link.bill_id), String(link.month)); } catch (e) { out.warning = e.message; }
    } else {
      out.bill_match = await bp.suggestBill(tx);
    }
    res.json(out);
  } catch (e) { fail(res, 400, e.message); }
});

app.post('/api/transfers', requireAuth, (req, res) => {
  try {
    const { from_account_id, to_account_id, date, amount, amount_cents, memo } = req.body || {};
    const from = stmts.accountGet.get(toInt(from_account_id)), to = stmts.accountGet.get(toInt(to_account_id));
    if (!from || !to || from.id === to.id) throw new Error('Pick two different accounts');
    const d = imp.parseDate(date); if (!d) throw new Error('Date required');
    const amt = Math.abs(Number.isInteger(amount_cents) ? amount_cents : imp.parseAmount(amount)); if (!amt) throw new Error('Amount required');
    const given = UID_RE.test(String(req.body.transfer_id || '')) ? String(req.body.transfer_id) : null;
    if (given && db.prepare('SELECT 1 FROM transactions WHERE transfer_id = ?').get(given)) return res.json({ ok: true, transfer_id: given, repeat: true });
    const transfer_id = given || crypto.randomBytes(8).toString('hex');
    const uids = Array.isArray(req.body.uids) ? req.body.uids.map(u => UID_RE.test(String(u || '')) ? String(u) : null) : [];
    const base = { date: d, category: 'Transfer', memo: String(memo || '').trim(), check_no: '', status: '', transfer_id, import_batch_id: null, created_by: req.user.id, entered_by: req.user.display_name, uid: null };
    db.transaction(() => {
      stmts.txInsert.run({ ...base, account_id: from.id, payee: `Transfer to ${to.name}`, amount: -amt, uid: uids[0] || null });
      stmts.txInsert.run({ ...base, account_id: to.id, payee: `Transfer from ${from.name}`, amount: amt, uid: uids[1] || null });
      bumpRev();
    })();
    res.json({ ok: true, transfer_id });
  } catch (e) { fail(res, 400, e.message); }
});

app.patch('/api/transactions/:id', requireAuth, (req, res) => {
  const id = toInt(req.params.id); const cur = stmts.txGet.get(id);
  if (!cur) return fail(res, 404, 'No such transaction');
  try {
    const merged = { ...cur, ...req.body };
    if (req.body.amount === undefined && !Number.isInteger(req.body.amount_cents)) { merged.amount_cents = cur.amount; delete merged.amount; }
    const t = cleanTx(merged, req.user);
    stmts.txUpdate.run({ ...t, id }); bumpRev();
    if (t.amount !== cur.amount) bp.bpPushAmount(id).catch(() => {});
    res.json(stmts.txGet.get(id));
  } catch (e) { fail(res, 400, e.message); }
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  const cur = stmts.txGet.get(toInt(req.params.id));
  if (!cur) return fail(res, 404, 'No such transaction');
  if (cur.transfer_id) stmts.txDeleteTransfer.run(cur.transfer_id); else stmts.txDelete.run(cur.id);
  bumpRev();
  res.json({ ok: true });
});

// Autocomplete helpers
app.get('/api/suggest', requireAuth, (req, res) => {
  const acct = toInt(req.query.account);
  const lastCheck = acct ? db.prepare(`SELECT MAX(CAST(check_no AS INTEGER)) n FROM transactions WHERE account_id = ? AND check_no GLOB '[0-9]*' AND LENGTH(check_no) <= 6`).get(acct).n : null;
  res.json({
    // Each payee with the category it is filed under most often (ties -> the most recent one)
    payees: db.prepare(`WITH pc AS (
        SELECT payee, category, COUNT(*) n, MAX(id) last_id FROM transactions WHERE payee != '' GROUP BY payee, category
      ), best AS (
        SELECT payee, category, n, ROW_NUMBER() OVER (PARTITION BY payee ORDER BY (category = '') ASC, n DESC, last_id DESC) rn FROM pc
      )
      SELECT b.payee, b.category, t.n FROM best b JOIN (SELECT payee, COUNT(*) n FROM transactions WHERE payee != '' GROUP BY payee) t ON t.payee = b.payee
      WHERE b.rn = 1 ORDER BY t.n DESC LIMIT 400`).all(),
    categories: db.prepare(`SELECT category, COUNT(*) n FROM transactions WHERE category != '' GROUP BY category ORDER BY n DESC LIMIT 200`).all().map(r => r.category),
    next_check: lastCheck ? lastCheck + 1 : null
  });
});

app.post('/api/clear-all', requireAuth, (req, res) => {
  const ids = (req.body.ids || []).map(toInt).filter(Boolean);
  const st = db.prepare(`UPDATE transactions SET status = 'cleared', updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status = ''`);
  db.transaction(() => { for (const id of ids) st.run(req.user.display_name, id); bumpRev(); })();
  res.json({ ok: true, count: ids.length });
});

// ---------- Bill Pay link ----------
app.get('/api/bills/upcoming', requireAuth, async (req, res) => {
  const acct = toInt(req.query.account) || bp.linkAccount();
  const a = acct ? stmts.accountsAll.all().find(x => x.id === acct) : null;
  res.json(await bp.upcoming(acct, a ? a.balance : 0));
});
app.post('/api/bills/link', requireAuth, async (req, res) => {
  try { res.json(await bp.bpLinkTx(toInt(req.body.tx_id), String(req.body.bill_id || ''), String(req.body.month || ''))); }
  catch (e) { fail(res, 400, e.message); }
});
app.post('/api/bills/sync', requireAuth, async (req, res) => { await bp.bpSync(); res.json({ ok: true, rev: getRev() }); });
app.get('/api/paychecks', requireAuth, (req, res) => res.json(bp.upcomingPaychecks(toInt(req.query.account) || bp.linkAccount())));
app.put('/api/paychecks', requireAuth, (req, res) => {
  try {
    const { label, date, amount, amount_cents, skip } = req.body || {};
    bp.setExpected(String(label || ''), String(date || ''), skip ? null : (Number.isInteger(amount_cents) ? amount_cents : imp.parseAmount(amount)), bp.linkAccount());
    res.json({ ok: true, paychecks: bp.upcomingPaychecks(bp.linkAccount()) });
  } catch (e) { fail(res, 400, e.message); }
});
app.get('/api/link-settings', requireAuth, (req, res) => res.json(bp.linkSettings()));
app.put('/api/link-settings', requireAuth, (req, res) => {
  const b = req.body || {};
  if (b.account !== undefined && stmts.accountGet.get(toInt(b.account))) meta.set('bp_account', toInt(b.account));
  if (b.autopay !== undefined) meta.set('bp_autopay', b.autopay ? '1' : '0');
  if (Array.isArray(b.paydays)) bp.setPaydays(b.paydays.map(p => ({ ...p, anchor: imp.parseDate(p.anchor) || '' })));
  else if (b.payday_anchor !== undefined) { // older single-payday clients
    const d = imp.parseDate(b.payday_anchor);
    bp.setPaydays(d ? [{ anchor: d, every: toInt(b.payday_every) || 14, label: b.payday_label || 'Payday' }] : []);
  }
  bumpRev();
  res.json(bp.linkSettings());
});

// Summary by category for a period
app.get('/api/summary', requireAuth, (req, res) => {
  const { from, to, account } = req.query;
  const where = ['1=1'], vals = [];
  if (from) { where.push('date >= ?'); vals.push(from); }
  if (to) { where.push('date <= ?'); vals.push(to); }
  if (account) { where.push('account_id = ?'); vals.push(toInt(account)); }
  where.push("category != 'Transfer'");
  res.json(db.prepare(`SELECT category, SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) spent, SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) received, COUNT(*) n
    FROM transactions WHERE ${where.join(' AND ')} GROUP BY category ORDER BY spent DESC`).all(...vals));
});

// ---------- built-in bills ----------
app.get('/api/features', requireAuth, (req, res) => res.json({ bills: bills.enabled(), external_billpay: bp.mode() === 'external' }));
app.put('/api/features', requireAdmin, (req, res) => {
  if (req.body.bills !== undefined) { bills.setEnabled(!!req.body.bills); bumpRev(); }
  res.json({ bills: bills.enabled(), external_billpay: bp.mode() === 'external' });
});
const requireBills = (req, res, next) => bills.enabled() ? next() : fail(res, 400, 'Bills are turned off');
app.get('/api/bills', requireAuth, requireBills, (req, res) => res.json({ ...bills.getData(), cats: bills.CATS, link_account: bp.linkAccount() }));
app.post('/api/bills', requireAuth, requireBills, (req, res) => { try { res.json(bills.saveBill(req.body)); } catch (e) { fail(res, 400, e.message); } });
app.patch('/api/bills/:id', requireAuth, requireBills, (req, res) => { try { res.json(bills.saveBill(req.body, req.params.id)); } catch (e) { fail(res, 400, e.message); } });
app.delete('/api/bills/:id', requireAuth, requireBills, (req, res) => { bills.deleteBill(req.params.id); res.json({ ok: true }); });
app.post('/api/bills/pay', requireAuth, requireBills, async (req, res) => {
  try {
    const { month, bill_id, payment } = req.body || {};
    const p = payment == null ? null : { amount_cents: Number.isInteger(payment.amount_cents) ? payment.amount_cents : null, amount: payment.amount, by: req.user.display_name, at: payment.at || new Date().toISOString().slice(0, 19) };
    if (p && p.amount_cents == null) p.amount_cents = imp.parseAmount(p.amount) || 0;
    bills.setPayment(month, bill_id, p);
    await bp.bpSync(); // creates / removes the matching register entry right away
    res.json({ ok: true, ...bills.getData() });
  } catch (e) { fail(res, 400, e.message); }
});
app.post('/api/bills/import', requireAdmin, requireBills, (req, res) => {
  try { res.json(bills.importJson(req.body.data, { replace: !!req.body.replace })); } catch (e) { fail(res, 400, e.message); }
});
app.get('/api/bills/export.json', requireAuth, requireBills, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="billpay-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(bills.exportJson());
});

// ---------- import ----------
app.post('/api/import/preview', requireAuth, (req, res) => {
  const { filename = '', text = '', mapping, hasHeader = true, dayFirst = false, invertAmounts = false } = req.body || {};
  if (!text.trim()) return fail(res, 400, 'Empty file');
  const isQif = /\.qif$/i.test(filename) || /^!Type:/im.test(text.slice(0, 500));
  if (isQif) {
    const r = imp.parseQIF(text);
    return res.json({ format: 'qif', ...r, accountsInFile: [...new Set(r.transactions.map(t => t.account).filter(Boolean))] });
  }
  const rows = imp.parseCSV(text);
  if (!rows.length) return fail(res, 400, 'No rows found');
  const headers = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const map = mapping || imp.detectMapping(headers);
  const r = imp.normalizeRows(rows, map, { hasHeader, dayFirst, invertAmounts });
  res.json({ format: 'csv', headers, mapping: map, sample: rows.slice(hasHeader ? 1 : 0, 6), rowCount: rows.length - (hasHeader ? 1 : 0), ...r,
    accountsInFile: [...new Set(r.transactions.map(t => t.account).filter(Boolean))] });
});

app.post('/api/import/commit', requireAuth, (req, res) => {
  const { transactions = [], accountMap = {}, defaultAccountId, source = 'csv', filename = '', createAccounts = true, skipDuplicates = true } = req.body || {};
  if (!Array.isArray(transactions) || !transactions.length) return fail(res, 400, 'Nothing to import');
  const resolveAccount = {};
  let created = 0, skipped = 0, inserted = 0;
  // Duplicates are judged against what was already in the register, not against other rows of this same file
  // (a file can legitimately hold two identical $2.00 vending purchases on one day).
  const existing = new Set(db.prepare('SELECT account_id, date, amount, payee FROM transactions').all().map(r => `${r.account_id}|${r.date}|${r.amount}|${r.payee}`));
  try {
    const batchId = db.transaction(() => {
      const b = stmts.batchInsert.run(source, filename, req.user.id, 0).lastInsertRowid;
      for (const t of transactions) {
        const key = t.account || '';
        let accId = resolveAccount[key];
        if (!accId) {
          if (accountMap[key]) accId = toInt(accountMap[key]);
          else if (key) {
            const ex = stmts.accountByName.get(key);
            if (ex) accId = ex.id;
            else if (createAccounts) { accId = stmts.accountInsert.run(key, 'checking', 0, 0).lastInsertRowid; created++; }
          }
          if (!accId) accId = toInt(defaultAccountId);
          if (!accId || !stmts.accountGet.get(accId)) throw new Error(`No account for "${key || '(blank)'}"`);
          resolveAccount[key] = accId;
        }
        const date = imp.parseDate(t.date); if (!date) { skipped++; continue; }
        const amount = Number.isInteger(t.amount) ? t.amount : imp.parseAmount(t.amount); if (amount === null) { skipped++; continue; }
        const payee = String(t.payee || '').trim();
        if (skipDuplicates && existing.has(`${accId}|${date}|${amount}|${payee}`)) { skipped++; continue; }
        stmts.txInsert.run({ account_id: accId, date, payee, category: String(t.category || '').trim(), memo: String(t.memo || '').trim(), amount,
          check_no: String(t.check_no || '').trim(), status: ['cleared', 'reconciled'].includes(t.status) ? t.status : '', transfer_id: null, import_batch_id: b, created_by: req.user.id, entered_by: req.user.display_name, uid: null });
        inserted++;
      }
      bumpRev();
      if (inserted === 0) { stmts.batchDelete.run(b); return null; }
      db.prepare('UPDATE import_batches SET row_count = ? WHERE id = ?').run(inserted, b);
      return b;
    })();
    res.json({ ok: true, batchId, inserted, skipped, accountsCreated: created });
  } catch (e) { fail(res, 400, e.message); }
});

app.get('/api/import/batches', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT b.*, u.display_name AS user_name FROM import_batches b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT 50').all());
});
app.delete('/api/import/batches/:id', requireAuth, (req, res) => {
  const id = toInt(req.params.id); if (!stmts.batchGet.get(id)) return fail(res, 404, 'No such import');
  db.transaction(() => { stmts.batchDeleteTx.run(id); stmts.batchDelete.run(id); bumpRev(); })();
  res.json({ ok: true });
});

// ---------- export & backup ----------
const csvEsc = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
app.get('/api/export.csv', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT a.name account, t.date, t.check_no, t.payee, t.category, t.memo, t.amount, t.status, t.entered_by FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY a.name, t.date, t.id`).all();
  const lines = ['Account,Date,Check No,Payee,Category,Memo,Amount,Status,Entered By'];
  for (const r of rows) lines.push([r.account, r.date, r.check_no, r.payee, r.category, r.memo, (r.amount / 100).toFixed(2), r.status, r.entered_by].map(csvEsc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="checkbook-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\r\n'));
});
app.get('/api/backup.db', requireAdmin, async (req, res) => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  await db.backup(tmp);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="checkbook-backup-${new Date().toISOString().slice(0, 10)}.db"`);
  res.sendFile(tmp, () => fs.unlink(tmp, () => {}));
});

// ---------- offline sync (installed apps and the web app's offline copy) ----------
require('./sync').register(app, { requireAuth, cleanTx, stmts, fail, version: APP_VERSION });

// ---------- static / PWA ----------
// Code files are always revalidated (cheap with ETags) so an update shows on the next load; icons can cache.
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, setHeaders: (res, p) => { res.setHeader('Cache-Control', /\.(png|svg)$/.test(p) ? 'public, max-age=86400' : 'no-cache'); } }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => { console.error(err); fail(res, 500, 'Server error'); });

// ---------- nightly backups (checked hourly, one file per day, oldest pruned) ----------
// Second copy on a removable drive (e.g. a USB stick or second disk), mounted at OFFSITE_DIR.
// Only written when that folder is really a different drive than /data, so if the stick is
// unplugged nothing silently lands on the server's own disk instead.
const OFFSITE_DIR = process.env.OFFSITE_BACKUP_DIR || '';
function onSeparateDrive(dir) {
  try { const a = fs.statfsSync(dir), b = fs.statfsSync(DATA_DIR); return a.type !== b.type || a.blocks !== b.blocks; } catch { return false; }
}
function pruneBackups(dir) {
  const files = fs.readdirSync(dir).filter(f => /^checkbook-v2-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(dir, old));
}
async function backupTick() {
  const name = `checkbook-v2-${bp.localToday()}.db`;
  try {
    const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) { await db.backup(target); pruneBackups(dir); console.log(`[backup] wrote ${target}`); }
    meta.set('backup_last', new Date().toISOString()); meta.set('backup_last_file', name);
  } catch (e) { console.error('[backup] failed:', e.message); meta.set('backup_error', e.message); }
  if (!OFFSITE_DIR) return;
  try {
    if (!fs.existsSync(OFFSITE_DIR) || !onSeparateDrive(OFFSITE_DIR)) throw new Error('backup drive not found — is it plugged in / mounted?');
    const dir = path.join(OFFSITE_DIR, 'Checkbook Backups'); fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      const tmp = target + '.part';
      await db.backup(tmp); fs.renameSync(tmp, target); pruneBackups(dir);
      fs.writeFileSync(path.join(dir, 'README.txt'), 'Nightly copies of the household Checkbook database (newest = latest date).\r\nTo restore: stop the checkbook container, copy one of these over Docker\\checkbook\\data\\checkbook-v2.db\r\n(delete checkbook-v2.db-wal and -shm next to it), then start the container again.\r\n');
      console.log(`[backup] wrote ${target}`);
    }
    meta.set('offsite_last', new Date().toISOString()); meta.del('offsite_error');
  } catch (e) { console.error('[backup] USB copy failed:', e.message); meta.set('offsite_error', e.message); }
}
app.get('/api/backup-status', requireAuth, (req, res) => {
  let usbFiles = 0; try { usbFiles = fs.readdirSync(path.join(OFFSITE_DIR, 'Checkbook Backups')).filter(f => f.endsWith('.db')).length; } catch {}
  res.json({ last: meta.get('backup_last'), offsite_configured: !!OFFSITE_DIR, offsite_last: meta.get('offsite_last'), offsite_error: meta.get('offsite_error'), offsite_count: usbFiles, keep: KEEP_BACKUPS });
});
app.post('/api/backup-now', requireAdmin, async (req, res) => {
  // run immediately; today's file is skipped if it already exists, so remove it first for a fresh copy
  const name = `checkbook-v2-${bp.localToday()}.db`;
  for (const d of [path.join(DATA_DIR, 'backups'), OFFSITE_DIR && path.join(OFFSITE_DIR, 'Checkbook Backups')].filter(Boolean)) { try { fs.unlinkSync(path.join(d, name)); } catch {} }
  await backupTick();
  res.json({ ok: true, offsite_error: meta.get('offsite_error') || null });
});
setTimeout(backupTick, 15000); setInterval(backupTick, 3600 * 1000);
bp.startSyncLoop();

app.listen(PORT, '0.0.0.0', () => console.log(`Checkbook v${APP_VERSION} listening on ${PORT}, data in ${DB_PATH}`));

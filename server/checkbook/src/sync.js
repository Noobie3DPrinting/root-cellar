// Offline sync.
//
// Each device (the Windows app, the Android app, and the web app on an iPhone) keeps a full copy
// of the checkbook. While the server can't be reached, changes are queued on the device as "ops"
// and sent here when it's back. Rules that keep money safe:
//   * Every op has an id; an op that arrives twice is only applied once.
//   * New entries carry a permanent uid made on the device, so a retried "add" never doubles up.
//   * An offline edit only overwrites a field the server still has as it was when the device last saw it.
//     If someone else changed that field in the meantime, their change stays and the device is told.
//   * An offline delete is skipped if someone else edited the entry since.
//   * A bill marked paid offline is not paid twice if the other person already paid it.
const zlib = require('zlib');
const crypto = require('crypto');
const { db, meta, bumpRev, getRev } = require('./db');
const bp = require('./billpay');
const bills = require('./bills');

const TX_FIELDS = ['account_id', 'date', 'payee', 'category', 'memo', 'amount', 'check_no', 'status'];
const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_OPS = 500;

const q = {
  txByUid: db.prepare('SELECT * FROM transactions WHERE uid = ?'),
  txByTransfer: db.prepare('SELECT * FROM transactions WHERE transfer_id = ?'),
  opGet: db.prepare('SELECT result FROM sync_ops WHERE op_id = ?'),
  opPut: db.prepare('INSERT OR REPLACE INTO sync_ops (op_id, user_id, result) VALUES (?, ?, ?)'),
  txUpdate: db.prepare(`UPDATE transactions SET account_id=@account_id, date=@date, payee=@payee, category=@category, memo=@memo, amount=@amount,
    check_no=@check_no, status=@status, updated_by=@entered_by, updated_at=datetime('now') WHERE id=@id`),
  txDelete: db.prepare('DELETE FROM transactions WHERE id = ?'),
  txDeleteTransfer: db.prepare('DELETE FROM transactions WHERE transfer_id = ?')
};

const same = (a, b) => (a == null ? '' : a) === (b == null ? '' : b) || (typeof a === 'number' || typeof b === 'number') && Number(a) === Number(b);
const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);
const LABEL = { account_id: 'account', date: 'date', payee: 'payee', category: 'category', memo: 'memo', amount: 'amount', check_no: 'check #', status: 'cleared status' };
const show = (f, v) => f === 'amount' ? money(Number(v)) : f === 'status' ? (v || 'uncleared') : f === 'account_id' ? ((db.prepare('SELECT name FROM accounts WHERE id = ?').get(v) || {}).name || 'another account') : (v === '' || v == null ? '(blank)' : String(v));
const whoEdited = (tx, user) => !tx.updated_by ? 'Someone else' : tx.updated_by === user.display_name ? 'You (on another device)' : tx.updated_by;

function snapshot(req) {
  const linkAcct = bp.linkAccount();
  return {
    format: 1,
    rev: getRev(),
    version: req.appVersion,
    server_time: new Date().toISOString(),
    today: bp.localToday(),
    user: req.user,
    users: db.prepare('SELECT id, username, display_name, role FROM users ORDER BY id').all(),
    features: { bills: bills.enabled(), billpay: bp.enabled, billpay_mode: bp.mode() },
    accounts: db.prepare('SELECT * FROM accounts ORDER BY archived, sort_order, name').all(),
    transactions: db.prepare(`SELECT id, uid, account_id, date, payee, category, memo, amount, check_no, status, transfer_id, created_by, entered_by, updated_at
      FROM transactions ORDER BY id`).all(),
    bill_links: db.prepare('SELECT * FROM bill_links').all(),
    bills: bills.enabled() ? { ...bills.getData(), cats: bills.CATS, link_account: linkAcct } : null,
    link: bp.enabled ? bp.linkSettings() : null,
    expected: db.prepare('SELECT * FROM expected_deposits').all(),
    post_hour: Number(process.env.PAYDAY_POST_HOUR || 5)
  };
}

function sendJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 2048) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.end(zlib.gzipSync(body));
  }
  res.end(body);
}

function register(app, { requireAuth, cleanTx, stmts, fail, version }) {
  app.get('/api/sync/snapshot', requireAuth, (req, res) => { req.appVersion = version; sendJson(req, res, snapshot(req)); });

  app.post('/api/sync/push', requireAuth, async (req, res) => {
    const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops.slice(0, MAX_OPS) : null;
    if (!ops) return fail(res, 400, 'ops required');
    const results = [];
    for (const op of ops) {
      const id = String((op && op.op_id) || '');
      if (!UID_RE.test(id)) { results.push({ op_id: id, status: 'error', message: 'Bad op id' }); continue; }
      const prev = q.opGet.get(id);
      if (prev) { results.push({ ...JSON.parse(prev.result), op_id: id, repeat: true }); continue; }
      let r;
      try { r = await apply(op, req.user, { cleanTx, stmts }); }
      catch (e) { r = { status: 'error', message: e.message || 'Could not apply' }; }
      r.op_id = id;
      // Errors from bad input are final too (retrying won't help), so they are recorded like any result.
      q.opPut.run(id, req.user.id, JSON.stringify(r));
      results.push(r);
    }
    res.json({ results, rev: getRev() });
  });
}

async function apply(op, user, { cleanTx, stmts }) {
  switch (op.type) {
    case 'tx.create': {
      const src = op.tx || {};
      if (!UID_RE.test(String(src.uid || ''))) throw new Error('Bad entry id');
      const have = q.txByUid.get(src.uid);
      if (have) return { status: 'ok', id: have.id, note: 'already saved' };
      const t = cleanTx({ ...src, amount_cents: Number.isInteger(src.amount_cents) ? src.amount_cents : src.amount }, user);
      t.uid = src.uid;
      const id = stmts.txInsert.run(t).lastInsertRowid; bumpRev();
      const out = { status: 'ok', id };
      const link = op.bill_link || {};
      if (link.bill_id && link.month) {
        try { await bp.bpLinkTx(id, String(link.bill_id), String(link.month)); out.linked = true; }
        catch (e) { out.status = 'warning'; out.message = `"${t.payee || 'Entry'}" was saved, but it couldn't be marked paid in Bills: ${e.message}`; }
      }
      return out;
    }
    case 'transfer.create': {
      const tid = String(op.transfer_id || '');
      if (!UID_RE.test(tid)) throw new Error('Bad transfer id');
      if (q.txByTransfer.get(tid)) return { status: 'ok', note: 'already saved' };
      const from = stmts.accountGet.get(Number(op.from_account_id)), to = stmts.accountGet.get(Number(op.to_account_id));
      if (!from || !to || from.id === to.id) throw new Error('A transfer made offline points at an account that no longer exists');
      const amt = Math.abs(Number(op.amount_cents) || 0); if (!amt) throw new Error('Transfer amount missing');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(op.date))) throw new Error('Transfer date missing');
      const uids = Array.isArray(op.uids) ? op.uids : [];
      const base = { date: op.date, category: 'Transfer', memo: String(op.memo || '').trim().slice(0, 1000), check_no: '', status: '', transfer_id: tid, import_batch_id: null, created_by: user.id, entered_by: user.display_name };
      db.transaction(() => {
        stmts.txInsert.run({ ...base, account_id: from.id, payee: `Transfer to ${to.name}`, amount: -amt, uid: UID_RE.test(uids[0] || '') ? uids[0] : null });
        stmts.txInsert.run({ ...base, account_id: to.id, payee: `Transfer from ${from.name}`, amount: amt, uid: UID_RE.test(uids[1] || '') ? uids[1] : null });
        bumpRev();
      })();
      return { status: 'ok' };
    }
    case 'tx.update': {
      const cur = q.txByUid.get(String(op.uid || ''));
      const changes = op.changes || {}, base = op.base || {};
      const label = (cur && cur.payee) || (base.payee) || 'An entry';
      if (!cur) return { status: 'conflict', message: `Your offline change to "${label}" wasn't saved: someone deleted that entry.` };
      const applied = {}, conflicts = [];
      for (const f of Object.keys(changes)) {
        if (!TX_FIELDS.includes(f)) continue;
        if (same(cur[f], changes[f])) continue;
        if (same(cur[f], base[f])) applied[f] = changes[f];
        else conflicts.push(`${LABEL[f]} (kept ${show(f, cur[f])}, yours was ${show(f, changes[f])})`);
      }
      if (Object.keys(applied).length) {
        const merged = { ...cur, ...applied };
        merged.amount_cents = Number(merged.amount); delete merged.amount;
        const t = cleanTx(merged, user);
        q.txUpdate.run({ ...t, id: cur.id }); bumpRev();
        if (t.amount !== cur.amount) bp.bpPushAmount(cur.id).catch(() => {});
      }
      if (conflicts.length) return { status: 'conflict', message: `"${label}": ${whoEdited(cur, user)} changed it while you were offline, so these kept their new values: ${conflicts.join('; ')}.` };
      return { status: 'ok' };
    }
    case 'tx.delete': {
      const cur = q.txByUid.get(String(op.uid || ''));
      if (!cur) return { status: 'ok', note: 'already gone' };
      const base = op.base || {};
      const changed = TX_FIELDS.filter(f => f in base && !same(cur[f], base[f]));
      if (changed.length) return { status: 'conflict', message: `"${cur.payee || 'An entry'}" (${money(cur.amount)}) wasn't deleted: ${whoEdited(cur, user)} changed it while you were offline. Delete it again if you still want it gone.` };
      if (cur.transfer_id) q.txDeleteTransfer.run(cur.transfer_id); else q.txDelete.run(cur.id);
      bumpRev();
      return { status: 'ok' };
    }
    case 'bill.pay': {
      if (!bills.enabled()) throw new Error('Bills are turned off');
      const month = String(op.month || ''), billId = String(op.bill_id || '');
      const bill = bills.get(billId);
      if (!bill) return { status: 'conflict', message: 'A bill you marked offline was deleted, so it was skipped.' };
      const cur = bills.getPayment(month, billId), base = op.base || {};
      const name = bill.name + (bill.item ? ` · ${bill.item}` : '');
      if (op.payment) {
        const cents = Math.max(0, Math.round(Number(op.payment.amount_cents) || 0));
        if (cur && !base.paid && cur.paid_by === user.display_name && cur.amount_cents === cents) return { status: 'ok', note: 'already saved' };
        if (cur && !base.paid) return { status: 'conflict', message: `${name} was already marked paid by ${cur.paid_by || 'someone else'} (${money(cur.amount_cents)}), so it wasn't paid twice.` };
        if (cur && cur.amount_cents === cents) return { status: 'ok' };
        bills.setPayment(month, billId, { amount_cents: cents, by: user.display_name, at: String(op.payment.at || '').slice(0, 19) || new Date().toISOString().slice(0, 19) });
      } else {
        if (!cur) return { status: 'ok' };
        if (base.paid && Number(base.amount_cents) !== cur.amount_cents) return { status: 'conflict', message: `${name} wasn't unmarked: its payment was changed while you were offline.` };
        bills.setPayment(month, billId, null);
      }
      await bp.bpSync();
      return { status: 'ok' };
    }
    default:
      throw new Error(`Unknown change type ${op.type}`);
  }
}

module.exports = { register, snapshot, newUid: () => crypto.randomBytes(16).toString('hex') };

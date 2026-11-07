// One-time import from the previous Family Checkbook (Python) database.
// Runs automatically on first start when the new database is empty and the old file exists.
const Database = require('better-sqlite3');
const fs = require('fs');
const { db, meta, bumpRev, LEGACY_DB_PATH } = require('./db');

function legacyLooksRight(old) {
  try {
    const cols = old.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
    return cols.includes('amount_cents') && cols.includes('entered_by');
  } catch { return false; }
}

function migrateFrom(path = LEGACY_DB_PATH) {
  if (meta.get('migrated_from')) return { skipped: 'already migrated' };
  if (!fs.existsSync(path)) return { skipped: 'no legacy database' };
  if (db.prepare('SELECT COUNT(*) n FROM transactions').get().n > 0) return { skipped: 'new database already has data' };
  const old = new Database(path, { readonly: true, fileMustExist: true });
  if (!legacyLooksRight(old)) { old.close(); return { skipped: 'not a recognised checkbook database' }; }

  const accounts = old.prepare('SELECT * FROM accounts ORDER BY id').all();
  const txs = old.prepare('SELECT * FROM transactions ORDER BY id').all();
  const links = old.prepare('SELECT * FROM bill_links').all();
  const oldMeta = Object.fromEntries(old.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
  old.close();

  const insAcct = db.prepare('INSERT INTO accounts (id, name, type, starting_balance, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insTx = db.prepare(`INSERT INTO transactions (id, account_id, date, payee, category, memo, amount, check_no, status, entered_by, created_at, updated_at)
    VALUES (@id, @account_id, @date, @payee, @category, @memo, @amount, @check_no, @status, @entered_by, @created_at, @updated_at)`);
  const insLink = db.prepare('INSERT OR REPLACE INTO bill_links (month, bill_id, tx_id, amount_cents, state) VALUES (?, ?, ?, ?, ?)');

  const result = db.transaction(() => {
    let i = 0;
    for (const a of accounts) insAcct.run(a.id, a.name, /sav/i.test(a.name) ? 'savings' : 'checking', a.opening_cents, i++, a.created_at || new Date().toISOString());
    for (const t of txs) insTx.run({
      id: t.id, account_id: t.account_id, date: t.date, payee: t.payee || '', category: t.category || '', memo: t.memo || '',
      amount: t.amount_cents, check_no: t.check_no || '', status: t.cleared ? 'cleared' : '', entered_by: t.entered_by || '',
      created_at: t.created_at || new Date().toISOString(), updated_at: t.updated_at || t.created_at || new Date().toISOString()
    });
    for (const l of links) insLink.run(l.month, l.bill_id, l.tx_id, l.amount_cents, l.state);
    for (const k of ['bp_init', 'bp_account', 'bp_autopay', 'payday_anchor', 'payday_every', 'payday_label']) if (oldMeta[k] !== undefined) meta.set(k, oldMeta[k]);
    meta.set('migrated_from', path);
    meta.set('migrated_at', new Date().toISOString());
    bumpRev();
    return { accounts: accounts.length, transactions: txs.length, billLinks: links.length };
  })();
  return result;
}

module.exports = { migrateFrom };

if (require.main === module) {
  const r = migrateFrom(process.argv[2] || LEGACY_DB_PATH);
  console.log(r);
}

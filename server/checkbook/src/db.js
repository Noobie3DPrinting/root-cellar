const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// v2 keeps its own file so the previous checkbook's database is never touched.
const DB_PATH = process.env.DB_FILE || path.join(DATA_DIR, 'checkbook-v2.db');
const LEGACY_DB_PATH = process.env.LEGACY_DB || path.join(DATA_DIR, 'checkbook.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'checking',
  starting_balance INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  filename TEXT,
  user_id INTEGER REFERENCES users(id),
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  check_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  transfer_id TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  entered_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date, id);
CREATE INDEX IF NOT EXISTS idx_tx_payee ON transactions(payee);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bill_links (
  month TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  tx_id INTEGER,
  amount_cents INTEGER,
  state TEXT NOT NULL,
  PRIMARY KEY (month, bill_id)
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('rev', '0');
`);

// Small schema upgrades for databases created by v0.1
const cols = db.prepare(`PRAGMA table_info(transactions)`).all().map(c => c.name);
if (!cols.includes('entered_by')) db.exec(`ALTER TABLE transactions ADD COLUMN entered_by TEXT NOT NULL DEFAULT ''`);

// v0.4 offline sync: every register entry gets a permanent id that devices can create on their own
// while the server is unreachable, so an entry sent twice is never added twice.
if (!cols.includes('uid')) db.exec(`ALTER TABLE transactions ADD COLUMN uid TEXT`);
if (!cols.includes('updated_by')) db.exec(`ALTER TABLE transactions ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''`);
db.exec(`
UPDATE transactions SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_uid ON transactions(uid);
CREATE TRIGGER IF NOT EXISTS tx_uid_fill AFTER INSERT ON transactions WHEN NEW.uid IS NULL
BEGIN UPDATE transactions SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TABLE IF NOT EXISTS sync_ops (
  op_id TEXT PRIMARY KEY,
  user_id INTEGER,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT NOT NULL
);
`);
db.prepare(`DELETE FROM sync_ops WHERE applied_at < datetime('now', '-120 days')`).run();

db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();

const meta = {
  get: (k, d = null) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : d; },
  set: (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
  del: (k) => db.prepare('DELETE FROM meta WHERE key = ?').run(k)
};
const bumpRev = () => db.prepare(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'`).run();
const getRev = () => Number(meta.get('rev', '0'));

module.exports = { db, DB_PATH, DATA_DIR, LEGACY_DB_PATH, meta, bumpRev, getRev };

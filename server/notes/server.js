// Notes — self-hosted notes app. Zero dependencies: Node 22+ built-ins only.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '8085', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '14', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 90;
const APP_SESSION_DAYS = 365; // installed Windows / Android apps
// Origins the installed apps load their screens from (they only talk to this server, with a token instead of a cookie).
const APP_ORIGINS = new Set(['app://notes.local', 'https://notes.local', ...String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const MAX_BODY = 60 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'notes.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  prefs TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  shared INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  markdown INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  deleted INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  modified_by INTEGER,
  source_id TEXT
);
CREATE INDEX IF NOT EXISTS notes_changed ON notes(changed);
CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS notes_source ON notes(owner_id, source_id) WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by INTEGER
);
CREATE INDEX IF NOT EXISTS versions_note ON versions(note_id, saved_at);
CREATE TABLE IF NOT EXISTS purged (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`);

const now = () => Date.now();
const newId = () => crypto.randomBytes(12).toString('base64url');

// ---------- passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, s, k] = stored.split('$');
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(userId, days = SESSION_DAYS) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(sha(token), userId, now(), now() + days * 864e5);
  return token;
}
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function sessionUser(req) {
  const t = bearer(req) || parseCookies(req).notes_session;
  if (!t) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.prefs, s.expires FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(t));
  if (!row || row.expires < now()) return null;
  return row;
}
function isHttps(req) {
  return req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').includes('https');
}
function sessionCookie(req, token, maxAgeSec) {
  return `notes_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

// simple login throttle: 8 failures per 15 min per IP
const fails = new Map();
function throttled(ip) {
  const f = fails.get(ip);
  return f && f.count >= 8 && now() - f.first < 15 * 60e3;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || now() - f.first > 15 * 60e3) fails.set(ip, { count: 1, first: now() });
  else f.count++;
}

// ---------- helpers ----------
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { code: 400 }); }
}
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const s = String(t).trim().replace(/\s+/g, '-').slice(0, 60);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.slice(0, 50);
}
function noteOut(n) {
  return {
    id: n.id, owner_id: n.owner_id, shared: !!n.shared, content: n.content, tags: JSON.parse(n.tags),
    pinned: !!n.pinned, markdown: !!n.markdown, created: n.created, modified: n.modified, changed: n.changed,
    deleted: n.deleted || null, rev: n.rev, modified_by: n.modified_by,
  };
}
function canSee(user, n) { return n && (n.shared || n.owner_id === user.id); }

// Save a history snapshot. Groups rapid edits: replaces the newest snapshot if it is < 3 min old and by the same person.
function snapshot(noteId, content, userId, force = false) {
  const last = db.prepare('SELECT * FROM versions WHERE note_id = ? ORDER BY saved_at DESC, id DESC LIMIT 1').get(noteId);
  if (last && last.content === content) return;
  if (!force && last && last.saved_by === userId && now() - last.saved_at < 3 * 60e3) {
    db.prepare('UPDATE versions SET content = ?, saved_at = ? WHERE id = ?').run(content, now(), last.id);
  } else {
    db.prepare('INSERT INTO versions (note_id, content, saved_at, saved_by) VALUES (?,?,?,?)').run(noteId, content, now(), userId);
  }
  // keep the newest 100 snapshots per note
  db.prepare(`DELETE FROM versions WHERE note_id = ? AND id NOT IN
    (SELECT id FROM versions WHERE note_id = ? ORDER BY saved_at DESC, id DESC LIMIT 100)`).run(noteId, noteId);
}

// ---------- zip read / write (no dependencies) ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('Not a zip file'), { code: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnl = buf.readUInt16LE(local + 26), lel = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lnl + lel, local + 30 + lnl + lel + csize);
    if (!name.endsWith('/')) {
      if (method === 0) files[name] = data;
      else if (method === 8) files[name] = zlib.inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  return files;
}
function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- Simplenote import ----------
function parseDate(v, fallback) {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}
function importNotes(user, buf, filename) {
  let json = null;
  const txts = [];
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    const files = readZip(buf);
    const key = Object.keys(files).find((k) => /(^|\/)notes\.json$/i.test(k));
    if (key) json = JSON.parse(files[key].toString('utf8'));
    else for (const [k, v] of Object.entries(files)) if (/\.(txt|md)$/i.test(k)) txts.push({ name: k, text: v.toString('utf8') });
  } else if (/\.(txt|md)$/i.test(filename || '')) {
    txts.push({ name: filename, text: buf.toString('utf8') });
  } else {
    json = JSON.parse(buf.toString('utf8'));
  }
  const items = [];
  if (json) {
    for (const n of json.activeNotes || []) items.push({ n, trashed: false });
    for (const n of json.trashedNotes || []) items.push({ n, trashed: true });
  }
  const t0 = now();
  let added = 0, updated = 0, skipped = 0;
  const findSrc = db.prepare('SELECT id, modified FROM notes WHERE owner_id = ? AND source_id = ?');
  const ins = db.prepare(`INSERT INTO notes (id, owner_id, shared, content, tags, pinned, markdown, created, modified, changed, deleted, rev, modified_by, source_id)
    VALUES (?,?,0,?,?,?,?,?,?,?,?,1,?,?)`);
  const upd = db.prepare(`UPDATE notes SET content=?, tags=?, pinned=?, markdown=?, modified=?, changed=?, deleted=?, rev=rev+1, modified_by=? WHERE id=?`);
  db.exec('BEGIN');
  try {
    for (const { n, trashed } of items) {
      const content = String(n.content ?? '').replace(/\r\n/g, '\n');
      const sys = n.systemTags || [];
      const pinned = n.pinned === true || sys.includes('pinned') ? 1 : 0;
      const md = n.markdown === true || sys.includes('markdown') ? 1 : 0;
      const created = parseDate(n.creationDate, t0);
      const modified = parseDate(n.lastModified, created);
      const tags = JSON.stringify(cleanTags(n.tags || []));
      const del = trashed ? t0 : null;
      const src = n.id ? 'sn:' + n.id : null;
      const existing = src && findSrc.get(user.id, src);
      if (existing) {
        if (existing.modified >= modified) { skipped++; continue; }
        snapshot(existing.id, db.prepare('SELECT content FROM notes WHERE id=?').get(existing.id).content, user.id, true);
        upd.run(content, tags, pinned, md, modified, t0, del, user.id, existing.id);
        updated++;
      } else {
        const id = newId();
        ins.run(id, user.id, content, tags, pinned, md, created, modified, t0, del, user.id, src);
        snapshot(id, content, user.id, true);
        added++;
      }
    }
    for (const f of txts) {
      const id = newId();
      const content = f.text.replace(/\r\n/g, '\n');
      const src = 'file:' + sha(f.name + '\n' + content).slice(0, 32);
      if (findSrc.get(user.id, src)) { skipped++; continue; }
      ins.run(id, user.id, content, '[]', 0, 0, t0, t0, t0, null, user.id, src);
      snapshot(id, content, user.id, true);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, updated, skipped, total: items.length + txts.length };
}

// ---------- export ----------
function exportZip(user) {
  const rows = db.prepare('SELECT * FROM notes WHERE (owner_id = ? OR shared = 1) ORDER BY modified DESC').all(user.id);
  const entries = [];
  const used = new Set();
  const out = { exported: new Date().toISOString(), activeNotes: [], trashedNotes: [] };
  for (const r of rows) {
    const n = noteOut(r);
    const rec = { id: n.id, content: n.content, creationDate: new Date(n.created).toISOString(), lastModified: new Date(n.modified).toISOString(),
      tags: n.tags, pinned: n.pinned, markdown: n.markdown, shared: n.shared };
    (n.deleted ? out.trashedNotes : out.activeNotes).push(rec);
    const folder = n.deleted ? 'trash/' : n.shared ? 'shared/' : 'notes/';
    let base = (n.content.split('\n').find((l) => l.trim()) || 'Untitled').trim().replace(/[\\/:*?"<>|#]/g, '').slice(0, 60).trim() || 'Untitled';
    let name = folder + base + '.txt', i = 2;
    while (used.has(name.toLowerCase())) name = `${folder}${base} (${i++}).txt`;
    used.add(name.toLowerCase());
    entries.push({ name, data: Buffer.from(n.content, 'utf8') });
  }
  entries.unshift({ name: 'notes.json', data: Buffer.from(JSON.stringify(out, null, 2), 'utf8') });
  return writeZip(entries);
}

// ---------- backups ----------
function backup() {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `notes-${stamp}.db`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const olds = fs.readdirSync(BACKUP_DIR).filter((f) => /^notes-\d{4}-\d\d-\d\d\.db$/.test(f)).sort();
    while (olds.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, olds.shift()));
    console.log('Backup written', file);
  } catch (e) { console.error('Backup failed', e.message); }
}
function scheduleBackups() {
  const n = new Date();
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 3, 0, 0); // 3 AM
  setTimeout(() => { backup(); scheduleBackups(); }, next - n);
}
// housekeeping: expired sessions, 60-day-old purge tombstones
function housekeeping() {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
  db.prepare('DELETE FROM purged WHERE at < ?').run(now() - 60 * 864e5);
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    return serveStatic(req, res, '/index.html');
  }
  const ext = path.extname(file);
  const noCache = ['.html', '.webmanifest', '.js', '.css'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });

route('GET', '/api/status', false, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const u = sessionUser(req);
  send(res, 200, { setupNeeded: count === 0, user: u ? { id: u.id, username: u.username, display_name: u.display_name, prefs: JSON.parse(u.prefs) } : null });
});

route('POST', '/api/setup', false, async (req, res) => {
  const b = await readJson(req);
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return send(res, 403, { error: 'Already set up' });
  const err = validateNewUser(b);
  if (err) return send(res, 400, { error: err });
  const r = db.prepare('INSERT INTO users (username, display_name, pass_hash, created) VALUES (?,?,?,?)')
    .run(b.username.trim(), (b.display_name || b.username).trim(), hashPassword(b.password), now());
  const token = createSession(Number(r.lastInsertRowid));
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
});

function validateNewUser(b) {
  if (!b.username || !/^[A-Za-z0-9._-]{2,32}$/.test(b.username.trim())) return 'Username: 2–32 letters, numbers, dots, dashes';
  if (!b.password || b.password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

route('POST', '/api/login', false, async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (throttled(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  const b = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim());
  if (!u || !checkPassword(String(b.password || ''), u.pass_hash)) { noteFail(ip); return send(res, 401, { error: 'Wrong username or password' }); }
  fails.delete(ip);
  if (b.app) return send(res, 200, { ok: true, token: createSession(u.id, APP_SESSION_DAYS) }); // installed app: token, no cookie
  const token = createSession(u.id);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
});

route('POST', '/api/logout', true, (req, res) => {
  const t = bearer(req) || parseCookies(req).notes_session;
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
});

route('GET', '/api/users', true, (req, res) => {
  send(res, 200, db.prepare('SELECT id, username, display_name FROM users ORDER BY id').all());
});

route('POST', '/api/users', true, async (req, res, user) => {
  const b = await readJson(req);
  const err = validateNewUser(b);
  if (err) return send(res, 400, { error: err });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username.trim())) return send(res, 400, { error: 'That username is taken' });
  db.prepare('INSERT INTO users (username, display_name, pass_hash, created) VALUES (?,?,?,?)')
    .run(b.username.trim(), (b.display_name || b.username).trim(), hashPassword(b.password), now());
  send(res, 200, { ok: true });
});

route('POST', '/api/password', true, async (req, res, user) => {
  const b = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!checkPassword(String(b.current || ''), u.pass_hash)) return send(res, 400, { error: 'Current password is wrong' });
  if (!b.password || b.password.length < 8) return send(res, 400, { error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), user.id);
  send(res, 200, { ok: true });
});

route('PUT', '/api/prefs', true, async (req, res, user) => {
  const b = await readJson(req);
  const prefs = { ...JSON.parse(user.prefs), ...b };
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs).slice(0, 4000), user.id);
  send(res, 200, prefs);
});

// All visible notes, or only changes since a timestamp
route('GET', '/api/notes', true, (req, res, user, q) => {
  const since = parseInt(q.get('since') || '0', 10);
  const rows = db.prepare('SELECT * FROM notes WHERE (owner_id = ? OR shared = 1) AND changed > ?').all(user.id, since);
  // notes that became invisible (unshared by someone else) since last sync
  const hidden = since ? db.prepare('SELECT id FROM notes WHERE owner_id != ? AND shared = 0 AND changed > ?').all(user.id, since).map((r) => r.id) : [];
  const purged = since ? db.prepare('SELECT id FROM purged WHERE at > ?').all(since).map((r) => r.id) : [];
  send(res, 200, { now: now(), notes: rows.map(noteOut), removed: [...hidden, ...purged] });
});

route('POST', '/api/notes', true, async (req, res, user) => {
  const b = await readJson(req);
  const id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(b.id) ? b.id : newId();
  if (db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) return send(res, 409, { error: 'exists' });
  const t = now();
  const content = typeof b.content === 'string' ? b.content : '';
  db.prepare(`INSERT INTO notes (id, owner_id, shared, content, tags, pinned, markdown, created, modified, changed, rev, modified_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`).run(id, user.id, b.shared ? 1 : 0, content, JSON.stringify(cleanTags(b.tags)),
    b.pinned ? 1 : 0, b.markdown ? 1 : 0, t, t, t, user.id);
  if (content) snapshot(id, content, user.id);
  send(res, 200, noteOut(db.prepare('SELECT * FROM notes WHERE id = ?').get(id)));
});

route('PUT', '/api/notes/:id', true, async (req, res, user, q, params) => {
  const b = await readJson(req);
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(params.id);
  if (!canSee(user, n)) return send(res, 404, { error: 'Not found' });
  const t = now();
  let conflict = false;
  let content = n.content, modified = n.modified;
  if (typeof b.content === 'string' && b.content !== n.content) {
    // someone else changed it since this device loaded it: keep their text in history so nothing is lost
    if (b.base_rev && b.base_rev !== n.rev && n.modified_by !== user.id) { snapshot(n.id, n.content, n.modified_by, true); conflict = true; }
    content = b.content;
    modified = t;
  }
  let shared = n.shared;
  if (typeof b.shared === 'boolean' && (b.shared ? 1 : 0) !== n.shared) {
    if (n.owner_id !== user.id) return send(res, 403, { error: `Only the person who made this note can make it private` });
    shared = b.shared ? 1 : 0;
  }
  const tags = Array.isArray(b.tags) ? JSON.stringify(cleanTags(b.tags)) : n.tags;
  const pinned = typeof b.pinned === 'boolean' ? (b.pinned ? 1 : 0) : n.pinned;
  const markdown = typeof b.markdown === 'boolean' ? (b.markdown ? 1 : 0) : n.markdown;
  let deleted = n.deleted;
  if (b.deleted === true && !n.deleted) deleted = t;
  if (b.deleted === false) deleted = null;
  db.prepare(`UPDATE notes SET content=?, tags=?, pinned=?, markdown=?, shared=?, deleted=?, modified=?, changed=?, rev=rev+1, modified_by=? WHERE id=?`)
    .run(content, tags, pinned, markdown, shared, deleted, modified, t, user.id, n.id);
  if (content !== n.content) snapshot(n.id, content, user.id);
  send(res, 200, { ...noteOut(db.prepare('SELECT * FROM notes WHERE id = ?').get(n.id)), conflict });
});

route('DELETE', '/api/notes/:id', true, (req, res, user, q, params) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(params.id);
  if (!canSee(user, n)) return send(res, 404, { error: 'Not found' });
  if (!n.deleted) return send(res, 400, { error: 'Move it to the trash first' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  db.prepare('INSERT OR REPLACE INTO purged VALUES (?,?)').run(n.id, now());
  send(res, 200, { ok: true });
});

route('POST', '/api/trash/empty', true, (req, res, user) => {
  const ids = db.prepare('SELECT id FROM notes WHERE deleted IS NOT NULL AND (owner_id = ? OR shared = 1)').all(user.id).map((r) => r.id);
  const t = now();
  db.exec('BEGIN');
  for (const id of ids) { db.prepare('DELETE FROM notes WHERE id = ?').run(id); db.prepare('INSERT OR REPLACE INTO purged VALUES (?,?)').run(id, t); }
  db.exec('COMMIT');
  send(res, 200, { removed: ids.length });
});

route('GET', '/api/notes/:id/versions', true, (req, res, user, q, params) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(params.id);
  if (!canSee(user, n)) return send(res, 404, { error: 'Not found' });
  send(res, 200, db.prepare(`SELECT v.id, v.content, v.saved_at, u.display_name AS saved_by FROM versions v
    LEFT JOIN users u ON u.id = v.saved_by WHERE note_id = ? ORDER BY saved_at DESC, v.id DESC`).all(n.id));
});

route('POST', '/api/import', true, async (req, res, user, q) => {
  const buf = await readBody(req);
  if (!buf.length) return send(res, 400, { error: 'No file' });
  try { send(res, 200, importNotes(user, buf, q.get('name') || '')); }
  catch (e) { send(res, 400, { error: 'Could not read that file: ' + e.message }); }
});

route('GET', '/api/export', true, (req, res, user) => {
  const zip = exportZip(user);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="notes-${new Date().toISOString().slice(0, 10)}.zip"`, 'Cache-Control': 'no-store' });
  res.end(zip);
});

route('POST', '/api/backup', true, (req, res) => { backup(); send(res, 200, { ok: true }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && APP_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Notes');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      }
      // CSRF guard: state-changing calls must come from our own page
      if (req.method !== 'GET' && req.headers['x-notes'] !== '1') return send(res, 403, { error: 'Forbidden' });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        let user = null;
        if (r.auth) { user = sessionUser(req); if (!user) return send(res, 401, { error: 'Sign in' }); }
        return await r.fn(req, res, user, url.searchParams, m.groups || {});
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.code && typeof e.code === 'number' ? e.code : 500, { error: e.message || 'Server error' });
  }
});

housekeeping();
// Forgot a password? On the server:  sudo docker exec root-cellar-notes node server.js reset-password <username> <new password>
if (process.argv[2] === 'reset-password') {
  const [uname, pw] = process.argv.slice(3);
  const u = uname && db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (!u || !pw || pw.length < 8) { console.log('Usage: node server.js reset-password <username> <new password (8+ characters)>'); process.exit(1); }
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
  try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); } catch {}
  console.log('Password changed for ' + uname); process.exit(0);
}
setInterval(housekeeping, 6 * 3600e3);
scheduleBackups();
if (!fs.readdirSync(BACKUP_DIR).some((f) => f.endsWith('.db'))) setTimeout(backup, 5000);
server.listen(PORT, () => console.log(`Notes running on port ${PORT}`));
process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });

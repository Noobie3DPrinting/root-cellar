// Root Cellar Movies — your disc collection and wishlist, on your own server.
// Zero-dependency Node 22 server: node:sqlite + http. Data lives in /data.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8093;
const DATA = process.env.DATA_DIR || '/data';
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'movies.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list TEXT NOT NULL DEFAULT 'collection',
  title TEXT NOT NULL, year INTEGER, kind TEXT DEFAULT 'Movie',
  format TEXT DEFAULT '', edition TEXT DEFAULT '', season TEXT DEFAULT '',
  tote TEXT DEFAULT '', ripped INTEGER,            -- ripped: NULL=auto (Jellyfin), 1=yes, 0=no
  barcode TEXT DEFAULT '', poster TEXT DEFAULT '', overview TEXT DEFAULT '',
  tmdb_id TEXT DEFAULT '', imdb_id TEXT DEFAULT '', media_type TEXT DEFAULT '',
  rating TEXT DEFAULT '', genre TEXT DEFAULT '', runtime INTEGER, discs TEXT DEFAULT '',
  series TEXT DEFAULT '', series_order TEXT DEFAULT '',
  actors TEXT DEFAULT '', directors TEXT DEFAULT '', studios TEXT DEFAULT '', imdb_rating TEXT DEFAULT '',
  notes TEXT DEFAULT '', personal_rating TEXT DEFAULT '', loaned_to TEXT DEFAULT '',
  purchase_price TEXT DEFAULT '', purchase_date TEXT DEFAULT '', purchased_from TEXT DEFAULT '',
  added_by TEXT DEFAULT '', icollect_id TEXT DEFAULT '', orig_title TEXT DEFAULT '',
  match_tried INTEGER DEFAULT 0,
  date_added TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS items_barcode ON items(barcode);
CREATE TABLE IF NOT EXISTS barcodes(code TEXT PRIMARY KEY, title TEXT, raw TEXT, source TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS jf_items(id TEXT PRIMARY KEY, name TEXT, year INTEGER, type TEXT, tmdb TEXT, imdb TEXT, norm TEXT);
`);

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const getSetting = (k, d = '') => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : (process.env[k.toUpperCase()] || d); };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? ''));


// ---------- people & sign-in ----------
const crypto = require('node:crypto');
const SESSION_DAYS = +process.env.SESSION_DAYS || 365;
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
const pubUser = u => u && ({ id: u.id, name: u.name, admin: !!u.admin });
function cookies(req) { const o = {}; for (const c of String(req.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } return o; }
function sessionUser(req) {
  const t = cookies(req).mv_session || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const r = db.prepare('SELECT u.*, s.created_at sc FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t);
  if (!r) return null;
  if (Date.now() - Date.parse(r.sc.replace(' ', 'T') + 'Z') > SESSION_DAYS * 864e5) { db.prepare('DELETE FROM sessions WHERE token=?').run(t); return null; }
  db.prepare('UPDATE sessions SET last_seen=? WHERE token=?').run(now(), t);
  r.token = t; return r;
}
function startSession(res, req, user) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,created_at,last_seen) VALUES(?,?,?,?)').run(t, user.id, now(), now());
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mv_session=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
const loginFails = new Map(); // ip -> [count, firstAt]
function tooMany(req) { const ip = req.socket.remoteAddress; const f = loginFails.get(ip); if (!f) return false; if (Date.now() - f[1] > 15 * 60e3) { loginFails.delete(ip); return false; } return f[0] >= 10; }
function failed(req) { const ip = req.socket.remoteAddress; const f = loginFails.get(ip) || [0, Date.now()]; f[0]++; loginFails.set(ip, f); }
const features = () => ({ storage: getSetting('feature_storage', '0') === '1', storage_label: getSetting('storage_label', 'Tote') || 'Tote', ripped: getSetting('feature_ripped', '0') === '1' });

const FIELDS = ['list','title','year','kind','format','edition','season','tote','ripped','barcode','poster','overview','tmdb_id','imdb_id','media_type','rating','genre','runtime','discs','series','series_order','actors','directors','studios','imdb_rating','notes','personal_rating','loaned_to','purchase_price','purchase_date','purchased_from','added_by','icollect_id','orig_title','date_added'];

// ---------- helpers ----------
function norm(s) {
  return String(s || '').replace(/[‘’']/g, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
}
function normCode(c) { c = String(c || '').replace(/\D/g, ''); if (c.length === 13 && c[0] === '0') c = c.slice(1); return c; }
function cleanUpcTitle(t) {
  let s = String(t || '');
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ');
  s = s.replace(/\b(4k|ultra ?hd|uhd|blu[- ]?ray|bluray|blu ray|dvd|digital( hd| copy| code)?|combo( pack)?|steelbook|widescreen|full ?screen|hdr|dolby vision|\+|includes?|with|w\/|ws|fs|2-?disc|3-?disc|\d+-disc|disc|region [a-c1-6]|special edition|collector'?s edition|anniversary edition|limited edition|exclusive|new|sealed|movie only|bilingual)\b/gi, ' ');
  s = s.replace(/\s[-–|:]\s*$/, '').replace(/\s+/g, ' ').replace(/^[\s\-–:,]+|[\s\-–:,/]+$/g, '').trim();
  return s;
}
function yearIn(t) { const m = String(t || '').match(/\b(19[2-9]\d|20[0-4]\d)\b/); return m ? +m[1] : null; }
async function fetchJSON(url, opts = {}, ms = 12000) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { ok: r.ok, status: r.status, json: j, headers: r.headers, text: txt }; }
  finally { clearTimeout(tm); }
}

// ---------- seed from iCollect on first start ----------
function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const f = path.join(__dirname, 'seed.json');
  if (n || !fs.existsSync(f)) return;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cols = FIELDS.filter(c => c !== 'ripped');
  const ins = db.prepare(`INSERT INTO items(${cols.join(',')},updated_at) VALUES(${cols.map(() => '?').join(',')},?)`);
  const insB = db.prepare('INSERT OR IGNORE INTO barcodes(code,title,raw,source,fetched_at) VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  for (const r of rows) {
    ins.run(...cols.map(c => r[c] ?? (c === 'year' || c === 'runtime' ? null : '')), now());
    if (r.barcode) insB.run(normCode(r.barcode), r.title, '', 'icollect', now());
  }
  db.exec('COMMIT');
  console.log('Seeded', rows.length, 'items from iCollect export');
}
seed();

// ---------- Jellyfin (ripped detection + metadata search) ----------
const jf = () => ({ url: (getSetting('jellyfin_url', '')).replace(/\/$/, ''), key: getSetting('jellyfin_key') });
let jfIndex = { tmdb: new Map(), imdb: new Map(), ty: new Map(), t: new Map(), at: null, count: 0, error: '' };
function buildJfIndex() {
  const idx = { tmdb: new Map(), imdb: new Map(), ty: new Map(), t: new Map(), at: getSetting('jf_synced_at'), count: 0, error: getSetting('jf_error') };
  for (const r of db.prepare('SELECT * FROM jf_items').all()) {
    idx.count++;
    if (r.tmdb) idx.tmdb.set(r.type[0] + r.tmdb, r);
    if (r.imdb) idx.imdb.set(r.imdb, r);
    idx.ty.set(r.norm + '|' + r.year, r);
    if (!idx.t.has(r.norm)) idx.t.set(r.norm, r);
  }
  jfIndex = idx;
}
buildJfIndex();
async function syncJellyfin() {
  const { url, key } = jf();
  if (!key) { setSetting('jf_error', 'No Jellyfin API key set'); buildJfIndex(); return; }
  const h = { 'X-Emby-Token': key };
  const q = 'Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,ProductionYear&EnableImages=false';
  try {
    let r = await fetchJSON(`${url}/Items?${q}`, { headers: h }, 60000);
    if (!r.ok || !r.json || !r.json.Items) {
      const u = await fetchJSON(`${url}/Users`, { headers: h });
      const admin = (u.json || []).find(x => x.Policy && x.Policy.IsAdministrator) || (u.json || [])[0];
      if (!admin) throw new Error('Jellyfin said ' + r.status);
      r = await fetchJSON(`${url}/Users/${admin.Id}/Items?${q}`, { headers: h }, 60000);
    }
    const items = (r.json && r.json.Items) || [];
    const ins = db.prepare('INSERT INTO jf_items(id,name,year,type,tmdb,imdb,norm) VALUES(?,?,?,?,?,?,?)');
    db.exec('BEGIN'); db.exec('DELETE FROM jf_items');
    for (const it of items) {
      const p = it.ProviderIds || {};
      ins.run(it.Id, it.Name, it.ProductionYear || null, it.Type === 'Series' ? 'tv' : 'movie', p.Tmdb || '', p.Imdb || '', norm(it.Name));
    }
    db.exec('COMMIT');
    setSetting('jf_synced_at', now()); setSetting('jf_error', '');
  } catch (e) { setSetting('jf_error', String(e.message || e)); }
  buildJfIndex();
}
function jfMatch(it) {
  if (it.tmdb_id) { const m = jfIndex.tmdb.get((it.media_type === 'tv' || it.kind === 'TV' ? 't' : 'm') + it.tmdb_id); if (m) return m; }
  if (it.imdb_id && jfIndex.imdb.get(it.imdb_id)) return jfIndex.imdb.get(it.imdb_id);
  const n = norm(it.title);
  if (it.year) { for (const y of [it.year, it.year - 1, it.year + 1]) { const m = jfIndex.ty.get(n + '|' + y); if (m) return m; } }
  else if (jfIndex.t.get(n)) return jfIndex.t.get(n);
  return null;
}
function decorate(it) {
  const m = jfMatch(it);
  it.jf = !!m; it.jf_name = m ? m.name : '';
  it.is_ripped = it.ripped === null || it.ripped === undefined ? !!m : !!it.ripped;
  return it;
}

// metadata search: TMDB (if key) else Jellyfin RemoteSearch (which uses TMDB behind the scenes)
async function searchMeta(q, year, type) {
  q = String(q || '').trim(); if (!q) return [];
  const tmdbKey = getSetting('tmdb_key');
  const out = [];
  if (tmdbKey) {
    const bearer = tmdbKey.length > 40;
    const u = `https://api.themoviedb.org/3/search/multi?include_adult=false&query=${encodeURIComponent(q)}${bearer ? '' : '&api_key=' + tmdbKey}`;
    const r = await fetchJSON(u, bearer ? { headers: { Authorization: 'Bearer ' + tmdbKey } } : {});
    for (const x of (r.json && r.json.results) || []) {
      if (x.media_type !== 'movie' && x.media_type !== 'tv') continue;
      const yr = +(String(x.release_date || x.first_air_date || '').slice(0, 4)) || null;
      out.push({ title: x.title || x.name, year: yr, media_type: x.media_type, tmdb_id: String(x.id), imdb_id: '', overview: x.overview || '', poster: x.poster_path ? 'https://image.tmdb.org/t/p/w342' + x.poster_path : '' });
    }
  } else {
    const { url, key } = jf(); if (!key) throw new Error('No Jellyfin API key set');
    const kinds = type === 'tv' ? ['Series'] : type === 'movie' ? ['Movie'] : ['Movie', 'Series'];
    await Promise.all(kinds.map(async k => {
      const body = { SearchInfo: { Name: q, ...(year ? { Year: +year } : {}) }, IncludeDisabledProviders: true };
      const r = await fetchJSON(`${url}/Items/RemoteSearch/${k}`, { method: 'POST', headers: { 'X-Emby-Token': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
      for (const x of Array.isArray(r.json) ? r.json : []) {
        const p = x.ProviderIds || {};
        out.push({ title: x.Name, year: x.ProductionYear || null, media_type: k === 'Series' ? 'tv' : 'movie', tmdb_id: p.Tmdb || '', imdb_id: p.Imdb || '', overview: x.Overview || '', poster: (x.ImageUrl || '').replace('/t/p/original/', '/t/p/w342/') });
      }
    }));
  }
  // rank: exact title first, then year closeness
  const nq = norm(q);
  const seen = new Set();
  return out.filter(x => { const k = x.media_type + (x.tmdb_id || x.title + x.year); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(x => ({ ...x, _s: (norm(x.title) === nq ? 0 : norm(x.title).startsWith(nq) ? 1 : 2) * 100 + (year && x.year ? Math.abs(x.year - year) : 50) + (x.poster ? 0 : 20) }))
    .sort((a, b) => a._s - b._s).slice(0, 12).map(({ _s, ...x }) => x);
}

// ---------- barcode lookup ----------
function upcUsage() {
  const day = new Date().toISOString().slice(0, 10);
  if (getSetting('upc_day') !== day) { setSetting('upc_day', day); setSetting('upc_used', 0); setSetting('upc_remaining', ''); }
  return { used: +getSetting('upc_used', 0), remaining: getSetting('upc_remaining') };
}
async function lookupBarcode(raw) {
  const code = normCode(raw);
  if (!code) return { code, error: 'Not a barcode' };
  const like = [code, '0' + code, code.replace(/^0/, '')];
  const all = db.prepare(`SELECT * FROM items WHERE barcode IN (${like.map(() => '?').join(',')})`).all(...like).map(decorate);
  const res = { code, owned: all.filter(i => i.list === 'collection'), wishlist: all.filter(i => i.list === 'wishlist'), product: '', query: '', year: null, candidates: [], source: '' };
  let cached = db.prepare('SELECT * FROM barcodes WHERE code=?').get(code);
  if (!cached || !cached.title) {
    upcUsage();
    const r = await fetchJSON(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
    setSetting('upc_used', +getSetting('upc_used', 0) + 1);
    const rem = r.headers && r.headers.get('x-ratelimit-remaining'); if (rem !== null && rem !== undefined) setSetting('upc_remaining', rem);
    if (r.status === 429) res.error = 'Barcode lookups are used up for today (free limit is 100/day). Search by title instead.';
    const it = r.json && r.json.items && r.json.items[0];
    if (it && it.title) {
      db.prepare('INSERT OR REPLACE INTO barcodes(code,title,raw,source,fetched_at) VALUES(?,?,?,?,?)').run(code, it.title, JSON.stringify(it).slice(0, 4000), 'upcitemdb', now());
      cached = { title: it.title, source: 'upcitemdb' };
    } else if (!res.error) res.error = "That barcode isn't in the free barcode database. Search by title instead.";
  }
  if (cached && cached.title) {
    res.product = cached.title; res.source = cached.source;
    res.query = cached.source === 'upcitemdb' ? cleanUpcTitle(cached.title) : cached.title;
    res.year = yearIn(cached.title);
    try { res.candidates = await searchMeta(res.query, res.year); } catch (e) { res.search_error = String(e.message || e); }
  }
  // wishlist entries that are the same movie by title/tmdb (barcode can differ between editions)
  if (res.candidates.length || res.query) {
    const top = res.candidates[0];
    const wl = db.prepare("SELECT * FROM items WHERE list='wishlist'").all();
    const nq = norm(top ? top.title : res.query);
    for (const w of wl) if (!res.wishlist.find(x => x.id === w.id) && ((top && top.tmdb_id && w.tmdb_id === top.tmdb_id) || norm(w.title) === nq)) res.wishlist.push(decorate(w));
    const own = db.prepare("SELECT * FROM items WHERE list='collection'").all();
    res.owned_similar = own.filter(o => !res.owned.find(x => x.id === o.id) && ((top && top.tmdb_id && o.tmdb_id === top.tmdb_id) || norm(o.title) === nq)).map(decorate);
  }
  return res;
}

// ---------- poster backfill (slow, in background) ----------
let backfill = { running: false, done: 0, total: 0, matched: 0 };
async function runBackfill() {
  if (backfill.running) return; if (!jf().key && !getSetting('tmdb_key')) return;
  const rows = db.prepare("SELECT id,title,year,kind FROM items WHERE (poster='' OR poster IS NULL) AND match_tried=0").all();
  backfill = { running: true, done: 0, total: rows.length, matched: 0 };
  const upd = db.prepare('UPDATE items SET poster=?, tmdb_id=CASE WHEN tmdb_id=\'\' THEN ? ELSE tmdb_id END, imdb_id=CASE WHEN imdb_id=\'\' THEN ? ELSE imdb_id END, media_type=?, overview=CASE WHEN overview=\'\' THEN ? ELSE overview END, match_tried=1 WHERE id=?');
  const miss = db.prepare('UPDATE items SET match_tried=1 WHERE id=?');
  for (const r of rows) {
    try {
      const q = r.title.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\b(trilogy|collection|anthology|box set|\d+-film|\d+-movie|complete series)\b.*$/i, '').replace(/^(.*?)\s+\d+\s*:\s*(.+)$/, '$2').trim() || r.title;
      let c = await searchMeta(q, r.year, r.kind === 'TV' ? 'tv' : 'movie');
      if (!c.length && q !== r.title) c = await searchMeta(r.title, r.year, r.kind === 'TV' ? 'tv' : 'movie');
      let best = c.find(x => x.poster && r.year && x.year && Math.abs(x.year - r.year) <= 1) || (!r.year ? c.find(x => x.poster) : null) || c.find(x => x.poster && norm(x.title) === norm(q));
      if (best) { upd.run(best.poster, best.tmdb_id, best.imdb_id, best.media_type, best.overview, r.id); backfill.matched++; } else miss.run(r.id);
    } catch (e) { /* leave for next run */ }
    backfill.done++;
    await new Promise(s => setTimeout(s, 700));
  }
  backfill.running = false;
}

// ---------- backups ----------
function backup() {
  const f = path.join(DATA, 'backups', `movies-${new Date().toISOString().slice(0, 10)}.db`);
  try { if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); } catch (e) { console.error('backup', e.message); }
  const files = fs.readdirSync(path.join(DATA, 'backups')).filter(x => x.endsWith('.db')).sort();
  while (files.length > 30) fs.unlinkSync(path.join(DATA, 'backups', files.shift()));
}

// ---------- CSV export ----------
function csvCell(v) { v = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportCsv() {
  const rows = db.prepare('SELECT * FROM items ORDER BY list, title').all().map(decorate);
  const cols = ['list', 'title', 'year', 'kind', 'format', 'edition', 'season', 'tote', 'is_ripped', 'barcode', 'genre', 'rating', 'runtime', 'discs', 'series', 'series_order', 'notes', 'loaned_to', 'personal_rating', 'purchase_price', 'purchase_date', 'purchased_from', 'added_by', 'date_added', 'tmdb_id', 'imdb_id'];
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(c === 'is_ripped' ? (r.is_ripped ? 'yes' : '') : r[c])).join(','))].join('\r\n');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, body, type = 'application/json', req) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': type };
  if (req && /gzip/.test(req.headers['accept-encoding'] || '') && buf.length > 1024 && !/image\/png/.test(type)) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; }
  if (type.startsWith('application/json')) h['Cache-Control'] = 'no-store';
  res.writeHead(code, h); res.end(buf);
}
function readBody(req) { return new Promise((ok, no) => { let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); }); }
function pick(o) {
  const out = {};
  for (const f of FIELDS) if (f in o) {
    let v = o[f];
    if (f === 'year' || f === 'runtime') v = v === '' || v === null || v === undefined ? null : (+v || null);
    else if (f === 'ripped') v = v === null || v === '' || v === undefined || v === 'auto' ? null : (v === true || v === 1 || v === '1' || v === 'yes') ? 1 : 0;
    else v = v === null || v === undefined ? '' : String(v);
    out[f] = v;
  }
  return out;
}
function getItem(id) { const r = db.prepare('SELECT * FROM items WHERE id=?').get(id); return r ? decorate(r) : null; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p.startsWith('/api/')) {
      const me = sessionUser(req);
      if (p === '/api/me') return send(res, 200, { needsSetup: userCount() === 0, user: pubUser(me), features: features() });
      if (p === '/api/setup' && req.method === 'POST') {
        if (userCount() > 0) return send(res, 400, { error: 'Already set up' });
        const b = await readBody(req); const name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!name || pw.length < 6) return send(res, 400, { error: 'Pick a name and a password of at least 6 characters' });
        const salt = crypto.randomBytes(16).toString('hex');
        const r = db.prepare('INSERT INTO users(name,salt,hash,admin,created_at) VALUES(?,?,?,1,?)').run(name, salt, hashPw(pw, salt), now());
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid); startSession(res, req, u); return send(res, 200, { user: pubUser(u) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes and try again.' });
        const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE name=?').get(String(b.name || '').trim());
        if (!u || hashPw(b.password || '', u.salt) !== u.hash) { failed(req); return send(res, 401, { error: 'Wrong name or password' }); }
        loginFails.delete(req.socket.remoteAddress); startSession(res, req, u); return send(res, 200, { user: pubUser(u) });
      }
      if (!me) return send(res, 401, { error: 'Please sign in' });
      if (p === '/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE token=?').run(me.token); res.setHeader('Set-Cookie', 'mv_session=; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
      if (p === '/api/me/password' && req.method === 'POST') {
        const b = await readBody(req); if (hashPw(b.current || '', me.salt) !== me.hash) return send(res, 400, { error: 'Current password is wrong' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use at least 6 characters' });
        const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(b.password, salt), me.id);
        db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(me.id, me.token); return send(res, 200, { ok: true });
      }
      if (p === '/api/users' && req.method === 'GET') return send(res, 200, db.prepare('SELECT id,name,admin FROM users ORDER BY id').all().map(pubUser));
      if (p === '/api/users' && req.method === 'POST') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can add people' });
        const b = await readBody(req); const name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!name || pw.length < 6) return send(res, 400, { error: 'Pick a name and a password of at least 6 characters' });
        if (db.prepare('SELECT 1 FROM users WHERE name=?').get(name)) return send(res, 400, { error: 'That name is taken' });
        const salt = crypto.randomBytes(16).toString('hex'); db.prepare('INSERT INTO users(name,salt,hash,admin,created_at) VALUES(?,?,?,?,?)').run(name, salt, hashPw(pw, salt), b.admin ? 1 : 0, now());
        return send(res, 200, { ok: true });
      }
      let um = p.match(/^\/api\/users\/(\d+)$/);
      if (um && req.method === 'DELETE') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can remove people' });
        if (+um[1] === me.id) return send(res, 400, { error: "You can't remove yourself" });
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(+um[1]); db.prepare('DELETE FROM users WHERE id=?').run(+um[1]); return send(res, 200, { ok: true });
      }
      if (um && req.method === 'PUT') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can reset passwords' });
        const b = await readBody(req); if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use at least 6 characters' });
        const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(b.password, salt), +um[1]);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(+um[1]); return send(res, 200, { ok: true });
      }
      if (p === '/api/items' && req.method === 'GET') {
        return send(res, 200, db.prepare('SELECT id,list,title,year,kind,format,edition,season,tote,ripped,barcode,poster,tmdb_id,imdb_id,media_type,genre,notes,loaned_to,added_by,date_added FROM items').all().map(decorate), 'application/json', req);
      }
      if (p === '/api/items' && req.method === 'POST') {
        const b = pick(await readBody(req)); if (!b.title) return send(res, 400, { error: 'Title required' });
        b.date_added = b.date_added || now(); b.list = b.list === 'wishlist' ? 'wishlist' : 'collection'; b.added_by = me.name;
        if (b.barcode) b.barcode = normCode(b.barcode);
        const k = Object.keys(b);
        const r = db.prepare(`INSERT INTO items(${k.join(',')},match_tried,updated_at) VALUES(${k.map(() => '?').join(',')},1,?)`).run(...k.map(x => b[x]), now());
        if (b.barcode && b.title) db.prepare("INSERT INTO barcodes(code,title,raw,source,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET title=excluded.title, source='app'").run(b.barcode, b.title, '', 'app', now());
        return send(res, 200, getItem(r.lastInsertRowid));
      }
      let m = p.match(/^\/api\/items\/(\d+)$/);
      if (m && req.method === 'GET') { const it = db.prepare('SELECT * FROM items WHERE id=?').get(+m[1]); return it ? send(res, 200, decorate(it)) : send(res, 404, { error: 'Not found' }); }
      if (m && req.method === 'PUT') {
        const b = pick(await readBody(req)); if ('added_by' in b) b.added_by = me.name; const k = Object.keys(b);
        if (b.barcode) b.barcode = normCode(b.barcode);
        if (k.length) db.prepare(`UPDATE items SET ${k.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...k.map(x => b[x]), now(), +m[1]);
        return send(res, 200, getItem(+m[1]));
      }
      if (m && req.method === 'DELETE') { db.prepare('DELETE FROM items WHERE id=?').run(+m[1]); return send(res, 200, { ok: true }); }
      if (p === '/api/barcode') return send(res, 200, await lookupBarcode(u.searchParams.get('code')));
      if (p === '/api/search') {
        try { return send(res, 200, await searchMeta(u.searchParams.get('q'), +u.searchParams.get('year') || null, u.searchParams.get('type') || '')); }
        catch (e) { return send(res, 200, { error: String(e.message || e) }); }
      }
      if (p === '/api/status') {
        const c = db.prepare("SELECT list, COUNT(*) n FROM items GROUP BY list").all();
        return send(res, 200, { counts: Object.fromEntries(c.map(x => [x.list, x.n])), jellyfin: { url: jf().url, has_key: !!jf().key, synced_at: jfIndex.at, items: jfIndex.count, error: getSetting('jf_error') }, tmdb: !!getSetting('tmdb_key'), upc: upcUsage(), backfill, features: features() });
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const b = await readBody(req);
        for (const k of ['jellyfin_url', 'jellyfin_key', 'tmdb_key']) if (k in b) setSetting(k, String(b[k]).trim());
        if ('storage' in b) setSetting('feature_storage', b.storage ? '1' : '0');
        if ('ripped' in b) setSetting('feature_ripped', b.ripped ? '1' : '0');
        if (b.jellyfin_key) setSetting('feature_ripped', '1');
        if ('storage_label' in b) setSetting('storage_label', String(b.storage_label).trim().slice(0, 20) || 'Tote');
        if ('storage' in b || 'storage_label' in b || 'ripped' in b) return send(res, 200, { ok: true, features: features() });
        syncJellyfin().then(runBackfill);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/jellyfin/sync' && req.method === 'POST') { await syncJellyfin(); return send(res, 200, { ok: !getSetting('jf_error'), items: jfIndex.count, error: getSetting('jf_error') }); }
      if (p === '/api/backfill' && req.method === 'POST') { if (u.searchParams.get('retry')) db.exec("UPDATE items SET match_tried=0 WHERE poster=''"); runBackfill(); return send(res, 200, backfill); }
      if (p === '/api/import' && req.method === 'POST') {
        const b = await readBody(req); const rows = Array.isArray(b.rows) ? b.rows : [];
        const cols = FIELDS.filter(c => !['ripped', 'icollect_id'].includes(c));
        const ins = db.prepare(`INSERT INTO items(${cols.join(',')},updated_at) VALUES(${cols.map(() => '?').join(',')},?)`);
        const insB = db.prepare('INSERT OR IGNORE INTO barcodes(code,title,raw,source,fetched_at) VALUES(?,?,?,?,?)');
        const exists = db.prepare('SELECT 1 FROM items WHERE list=? AND lower(title)=lower(?) AND IFNULL(year,0)=IFNULL(?,0) AND barcode=?');
        let added = 0, skipped = 0;
        db.exec('BEGIN');
        try {
          for (const raw of rows) {
            const r = pick(raw); if (!r.title) { skipped++; continue; }
            r.list = r.list === 'wishlist' ? 'wishlist' : 'collection'; r.barcode = normCode(r.barcode); r.added_by = r.added_by || me.name; r.date_added = r.date_added || now();
            if (exists.get(r.list, r.title, r.year ?? null, r.barcode || '')) { skipped++; continue; }
            ins.run(...cols.map(c => r[c] ?? (c === 'year' || c === 'runtime' ? null : '')), now());
            if (r.barcode) insB.run(r.barcode, r.title, '', 'import', now());
            added++;
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        setTimeout(() => syncJellyfin().then(runBackfill), 500);
        return send(res, 200, { added, skipped });
      }
      if (p === '/api/export.csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="movies-${new Date().toISOString().slice(0, 10)}.csv"` }); return res.end(exportCsv()); }
      return send(res, 404, { error: 'Unknown API' });
    }
    // static
    let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    const ext = path.extname(f);
    let buf = fs.readFileSync(f);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': /\.(html|webmanifest|js|css)$/.test(f) ? 'no-cache' : 'public, max-age=604800' };
    if (/gzip/.test(req.headers['accept-encoding'] || '') && /\.(html|js|css|webmanifest|svg)$/.test(f)) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; }
    res.writeHead(200, h); res.end(buf);
  } catch (e) {
    console.error(e); send(res, 500, { error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log('Movies listening on', PORT));

// jobs
setTimeout(() => { syncJellyfin().then(runBackfill); backup(); }, 3000);
setInterval(() => syncJellyfin(), 60 * 60 * 1000);        // refresh Ripped badges hourly
setInterval(() => { backup(); runBackfill(); }, 6 * 60 * 60 * 1000);

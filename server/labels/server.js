// Root Cellar Labels — design labels in the browser and print them on a label printer (DYMO LabelWriter
// and anything else CUPS can drive), or download them as a PDF to print from any computer.
// Zero-dependency Node 22 server. Data lives in DATA_DIR (labels.json + backups).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PORT = +process.env.PORT || 8095;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const FILE = path.join(DATA, 'labels.json');
const SESSION_DAYS = +process.env.SESSION_DAYS || 365;
const VERSION = require('./package.json').version;
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

// ---------- data ----------
const DEFAULT = () => ({ users: [], sessions: {}, printers: [], saved: [], recent: [], settings: { units: 'in' } });
let D;
try { D = { ...DEFAULT(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { D = DEFAULT(); }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(D));
    fs.renameSync(tmp, FILE);
  }, 50);
}
function backup() {
  const f = path.join(DATA, 'backups', `labels-${new Date().toISOString().slice(0, 10)}.json`);
  try { if (!fs.existsSync(f) && fs.existsSync(FILE)) fs.copyFileSync(FILE, f); } catch (e) { console.error('backup', e.message); }
  const files = fs.readdirSync(path.join(DATA, 'backups')).filter(x => x.endsWith('.json')).sort();
  while (files.length > 30) fs.unlinkSync(path.join(DATA, 'backups', files.shift()));
}
const id = () => crypto.randomBytes(6).toString('hex');

// ---------- people & sign-in ----------
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const pubUser = u => u && { id: u.id, name: u.name, admin: !!u.admin };
function cookies(req) { const o = {}; for (const c of String(req.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } return o; }
function sessionUser(req) {
  const t = cookies(req).lb_session || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = t && D.sessions[t];
  if (!s) return null;
  if (Date.now() - s.at > SESSION_DAYS * 864e5) { delete D.sessions[t]; save(); return null; }
  const u = D.users.find(x => x.id === s.user);
  return u ? { ...u, token: t } : null;
}
function startSession(res, req, u) {
  const t = crypto.randomBytes(32).toString('hex');
  D.sessions[t] = { user: u.id, at: Date.now() }; save();
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `lb_session=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
const fails = new Map();
const tooMany = req => { const f = fails.get(req.socket.remoteAddress); if (!f) return false; if (Date.now() - f[1] > 15 * 60e3) { fails.delete(req.socket.remoteAddress); return false; } return f[0] >= 10; };
const failed = req => { const f = fails.get(req.socket.remoteAddress) || [0, Date.now()]; f[0]++; fails.set(req.socket.remoteAddress, f); };
function newUser(name, pw, admin) {
  name = String(name || '').trim(); pw = String(pw || '');
  if (!name || pw.length < 6) throw new Error('Pick a name and a password of at least 6 characters');
  if (D.users.some(u => u.name.toLowerCase() === name.toLowerCase())) throw new Error('That name is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: id(), name, salt, hash: hashPw(pw, salt), admin: !!admin };
  D.users.push(u); save(); return u;
}

// ---------- printers (CUPS) ----------
const run = (cmd, args, timeout = 20000) => new Promise(ok => execFile(cmd, args, { timeout }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));
let cupsOk = null;
async function hasCups() { if (cupsOk === null) cupsOk = (await run('lpstat', ['-r'])).out.includes('is running'); return cupsOk; }
setInterval(() => { cupsOk = null; }, 60e3);
async function printerStatus() {
  if (!(await hasCups())) return { cups: false, queues: {} };
  const p = (await run('lpstat', ['-p'])).out, q = (await run('lpstat', ['-o'])).out;
  const queues = {};
  for (const pr of D.printers) {
    const m = p.match(new RegExp(`printer ${pr.queue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (is idle|now printing[^.]*|disabled[^.]*)`));
    queues[pr.queue] = { state: m ? m[1] : 'not found', jobs: q.split('\n').filter(l => l.startsWith(pr.queue + '-')).length, ok: !!m && !/disabled/.test(m[1]) };
  }
  return { cups: true, queues };
}
const QUEUE_RE = /^[A-Za-z0-9_-]{1,40}$/;
async function discover() {
  if (!(await hasCups())) return { cups: false, devices: [], models: [], queues: [] };
  const [v, m, a] = await Promise.all([run('lpinfo', ['-v'], 40000), run('lpinfo', ['-m'], 40000), run('lpstat', ['-v'])]);
  const devices = v.out.split('\n').map(l => l.trim().split(/\s+/)).filter(x => x.length >= 2 && /:\//.test(x[1])).map(x => ({ kind: x[0], uri: x[1] }))
    .filter(d => !/^(beh|cups-pdf|lpd|socket|ipp|ipps|http|https|smb)$/.test(d.uri.replace(/:.*/, '')) || d.uri.includes('//'));
  const models = m.out.split('\n').map(l => { const i = l.indexOf(' '); return i > 0 ? { ppd: l.slice(0, i), name: l.slice(i + 1).trim() } : null; })
    .filter(x => x && /dymo|labelwriter|zebra|brother.*ql|rollo|label/i.test(x.name + x.ppd)).slice(0, 80);
  const queues = a.out.split('\n').map(l => (l.match(/^device for ([^:]+):\s*(.*)$/) || []).slice(1)).filter(x => x.length).map(([queue, uri]) => ({ queue, uri }));
  return { cups: true, devices, models, queues };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function send(res, code, body, type = 'application/json', req) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
  if (req && /gzip/.test(req.headers['accept-encoding'] || '') && buf.length > 1024 && !/image\/png|woff2/.test(type)) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; }
  if (type.startsWith('application/json')) h['Cache-Control'] = 'no-store';
  res.writeHead(code, h); res.end(buf);
}
function readBody(req, max = 8e6) { return new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { no(new Error('Too big')); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { const s = Buffer.concat(ch).toString(); ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); }); }
const cleanLabel = l => {
  if (!l || typeof l !== 'object') throw new Error('Nothing to save');
  const s = JSON.stringify(l); if (s.length > 300000) throw new Error('That label is too big to save (try a smaller picture)');
  return JSON.parse(s);
};
const pubPrinter = p => ({ id: p.id, name: p.name, queue: p.queue, size: p.size || '', dx: +p.dx || 0, dy: +p.dy || 0 });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p.startsWith('/api/')) {
      const me = sessionUser(req);
      if (p === '/api/me') return send(res, 200, { needsSetup: D.users.length === 0, user: pubUser(me), version: VERSION });
      if (p === '/api/setup' && req.method === 'POST') {
        if (D.users.length) return send(res, 400, { error: 'Already set up' });
        const b = await readBody(req); const nu = newUser(b.name, b.password, true); startSession(res, req, nu); return send(res, 200, { user: pubUser(nu) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes and try again.' });
        const b = await readBody(req); const x = D.users.find(v => v.name.toLowerCase() === String(b.name || '').trim().toLowerCase());
        if (!x || hashPw(b.password || '', x.salt) !== x.hash) { failed(req); return send(res, 401, { error: 'Wrong name or password' }); }
        fails.delete(req.socket.remoteAddress); startSession(res, req, x); return send(res, 200, { user: pubUser(x) });
      }
      if (!me) return send(res, 401, { error: 'Please sign in' });
      if (p === '/api/logout' && req.method === 'POST') { delete D.sessions[me.token]; save(); res.setHeader('Set-Cookie', 'lb_session=; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
      if (p === '/api/me/password' && req.method === 'POST') {
        const b = await readBody(req); if (hashPw(b.current || '', me.salt) !== me.hash) return send(res, 400, { error: 'Current password is wrong' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use at least 6 characters' });
        const x = D.users.find(v => v.id === me.id); x.salt = crypto.randomBytes(16).toString('hex'); x.hash = hashPw(b.password, x.salt);
        for (const [t, s] of Object.entries(D.sessions)) if (s.user === me.id && t !== me.token) delete D.sessions[t];
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/users' && req.method === 'GET') return send(res, 200, D.users.map(pubUser));
      if (p === '/api/users' && req.method === 'POST') { if (!me.admin) return send(res, 403, { error: 'Only an admin can add people' }); const b = await readBody(req); newUser(b.name, b.password, b.admin); return send(res, 200, { ok: true }); }
      let um = p.match(/^\/api\/users\/([a-f0-9]+)$/);
      if (um && req.method === 'DELETE') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can remove people' });
        if (um[1] === me.id) return send(res, 400, { error: "You can't remove yourself" });
        D.users = D.users.filter(x => x.id !== um[1]); for (const [t, s] of Object.entries(D.sessions)) if (s.user === um[1]) delete D.sessions[t]; save(); return send(res, 200, { ok: true });
      }
      if (um && req.method === 'PUT') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can reset passwords' });
        const b = await readBody(req); if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use at least 6 characters' });
        const x = D.users.find(v => v.id === um[1]); if (!x) return send(res, 404, { error: 'Not found' });
        x.salt = crypto.randomBytes(16).toString('hex'); x.hash = hashPw(b.password, x.salt); for (const [t, s] of Object.entries(D.sessions)) if (s.user === x.id) delete D.sessions[t]; save(); return send(res, 200, { ok: true });
      }

      // state for the designer
      if (p === '/api/state') return send(res, 200, { saved: D.saved, recent: D.recent, printers: D.printers.map(pubPrinter), settings: D.settings, status: await printerStatus(), version: VERSION }, 'application/json', req);
      if (p === '/api/status') return send(res, 200, await printerStatus());
      if (p === '/api/settings' && req.method === 'PUT') { const b = await readBody(req); if (b.units === 'in' || b.units === 'mm') D.settings.units = b.units; save(); return send(res, 200, D.settings); }

      // print a finished PDF (the browser draws the label so the preview is exactly what prints)
      if (p === '/api/print' && req.method === 'POST') {
        const b = await readBody(req, 12e6);
        const pr = D.printers.find(x => x.id === b.printer); if (!pr) return send(res, 400, { error: 'Pick a printer' });
        const pdf = Buffer.from(String(b.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
        if (pdf.length < 100 || pdf.subarray(0, 5).toString() !== '%PDF-') return send(res, 400, { error: 'Nothing to print' });
        const copies = Math.max(1, Math.min(99, +b.copies || 1));
        const f = path.join(os.tmpdir(), `label-${id()}.pdf`); fs.writeFileSync(f, pdf);
        const opts = ['-d', pr.queue, '-n', String(copies), '-t', 'Label', '-o', 'print-scaling=none', '-o', 'fit-to-page=false'];
        if (b.media) opts.push('-o', `media=${String(b.media).replace(/[^A-Za-z0-9_.x-]/g, '')}`);
        const r = await run('lp', [...opts, f]); fs.unlink(f, () => {});
        if (r.code !== 0) return send(res, 500, { error: (r.err || r.out).trim() || 'The printer refused the job' });
        if (b.label) { try { const lab = cleanLabel(b.label); const key = JSON.stringify(lab.content || lab); D.recent = [{ id: id(), at: Date.now(), by: me.name, label: lab }, ...D.recent.filter(x => JSON.stringify(x.label.content || x.label) !== key)].slice(0, 20); save(); } catch {} }
        return send(res, 200, { ok: true, job: (r.out.match(/request id is (\S+)/) || [])[1] || '' });
      }

      // saved labels
      if (p === '/api/saved' && req.method === 'POST') {
        const b = await readBody(req); const lab = cleanLabel(b.label); const name = String(b.name || '').trim().slice(0, 80) || 'Label';
        const sid = b.id && D.saved.some(x => x.id === b.id) ? b.id : id();
        D.saved = D.saved.filter(x => x.id !== sid); D.saved.push({ id: sid, name, label: lab, at: Date.now(), by: me.name });
        D.saved.sort((a, z) => a.name.localeCompare(z.name, undefined, { numeric: true })); save(); return send(res, 200, { ok: true, id: sid });
      }
      let sm = p.match(/^\/api\/saved\/([a-f0-9]+)$/);
      if (sm && req.method === 'DELETE') { D.saved = D.saved.filter(x => x.id !== sm[1]); save(); return send(res, 200, { ok: true }); }
      if (p === '/api/recent' && req.method === 'DELETE') { D.recent = []; save(); return send(res, 200, { ok: true }); }
      if (p === '/api/export.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="labels-${new Date().toISOString().slice(0, 10)}.json"` }); return res.end(JSON.stringify({ saved: D.saved }, null, 1)); }
      if (p === '/api/import' && req.method === 'POST') {
        const b = await readBody(req); let n = 0;
        for (const x of (Array.isArray(b.saved) ? b.saved : [])) { try { D.saved.push({ id: id(), name: String(x.name || 'Label').slice(0, 80), label: cleanLabel(x.label), at: Date.now(), by: me.name }); n++; } catch {} }
        D.saved.sort((a, z) => a.name.localeCompare(z.name, undefined, { numeric: true })); save(); return send(res, 200, { added: n });
      }

      // printer setup (admin)
      if (p === '/api/printers/discover') { if (!me.admin) return send(res, 403, { error: 'Admin only' }); return send(res, 200, await discover()); }
      if (p === '/api/printers' && req.method === 'POST') {
        if (!me.admin) return send(res, 403, { error: 'Only an admin can set up printers' });
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 40) || 'Label printer';
        let queue = String(b.queue || '').trim();
        if (b.uri) { // create a new CUPS queue
          if (!(await hasCups())) return send(res, 400, { error: 'This server has no print system. Use "Download PDF" instead, or see the setup guide.' });
          queue = queue || name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'Label';
          if (!QUEUE_RE.test(queue)) return send(res, 400, { error: 'Printer name can only use letters, numbers, - and _' });
          const args = ['-p', queue, '-E', '-v', String(b.uri)];
          if (b.ppd) args.push('-m', String(b.ppd)); else args.push('-m', 'everywhere');
          const r = await run('lpadmin', args, 60000); if (r.code !== 0) return send(res, 400, { error: r.err.trim() || 'Could not add the printer' });
          if (b.slot === 'Left' || b.slot === 'Right') await run('lpadmin', ['-p', queue, '-o', `InputSlot=${b.slot}`]);
          await run('cupsenable', [queue]); await run('cupsaccept', [queue]);
        }
        if (!QUEUE_RE.test(queue)) return send(res, 400, { error: 'Pick a printer' });
        const pr = { id: b.id && D.printers.some(x => x.id === b.id) ? b.id : id(), name, queue, size: String(b.size || ''), dx: +b.dx || 0, dy: +b.dy || 0 };
        D.printers = [...D.printers.filter(x => x.id !== pr.id), pr]; save(); return send(res, 200, pubPrinter(pr));
      }
      let pm = p.match(/^\/api\/printers\/([a-f0-9]+)$/);
      if (pm && req.method === 'DELETE') { if (!me.admin) return send(res, 403, { error: 'Admin only' }); D.printers = D.printers.filter(x => x.id !== pm[1]); save(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'Unknown API' });
    }
    // static
    let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    const ext = path.extname(f);
    send(res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream', req);
  } catch (e) {
    console.error(e); send(res, /Pick|taken|characters|Too big|label is too big|Nothing/.test(e.message) ? 400 : 500, { error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`Root Cellar Labels v${VERSION} listening on ${PORT}`));
setTimeout(backup, 5000); setInterval(backup, 6 * 3600e3);

// Desktop app for Windows. One small program that opens each app in its own window,
// with its own taskbar icon. Start menu shortcuts pass --app=<id> to open one app directly.
//   Offline apps (screens bundled here, data synced with your server):  served from app://<host>/
//   Server apps (loaded from your server's address):                     address saved in config.json
const { app, BrowserWindow, protocol, shell, session, ipcMain, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const SUITE = require('./suite.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId(SUITE.appId);
Menu.setApplicationMenu(null);

const APPS = Object.fromEntries(SUITE.apps.map(a => [a.id, a]));
const HOSTS = Object.fromEntries(SUITE.apps.filter(a => a.kind === 'offline').map(a => [a.host, path.join(__dirname, 'apps', a.id)]));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2' };
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return { servers: {}, windows: {} }; } };
const writeCfg = c => { try { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 1)); } catch {} };
const cleanUrl = u => { u = String(u || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u; return u; };
const icon = id => path.join(__dirname, 'icons', id + '.ico');
const wins = {};

function argApp(argv) { const a = (argv || []).find(x => /^--app=/.test(x)); return a ? a.slice(6) : null; }

function openApp(id) {
  if (id !== 'launcher' && !APPS[id]) id = 'launcher';
  const existing = wins[id];
  if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return existing; }
  const a = APPS[id] || { id: 'launcher', name: SUITE.name, bg: SUITE.bg };
  const cfg = readCfg(); const b = { width: id === 'launcher' ? 560 : 1040, height: id === 'launcher' ? 640 : 820, ...(cfg.windows && cfg.windows[id]) };
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: 360, minHeight: 480, title: a.name, backgroundColor: a.bg || '#ffffff',
    icon: icon(id === 'launcher' ? 'suite' : id), autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, preload: path.join(__dirname, 'preload.js') }
  });
  wins[id] = win;
  if (process.platform === 'win32') {
    try { win.setAppDetails({ appId: `${SUITE.appId}.${id}`, appIconPath: icon(id === 'launcher' ? 'suite' : id), relaunchCommand: `"${process.execPath}" --app=${id}`, relaunchDisplayName: a.name }); } catch {}
  }
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => { const c = readCfg(); c.windows = c.windows || {}; c.windows[id] = { ...win.getNormalBounds(), maximized: win.isMaximized() }; writeCfg(c); });
  win.on('closed', () => { delete wins[id]; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { win.webContents.reload(); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === 'l') { openApp('launcher'); e.preventDefault(); }
  });
  load(win, id);
  return win;
}
function setupPage(win, id, error) { win.loadFile(path.join(__dirname, 'setup.html'), { query: { app: id, error: error || '' } }); }
function load(win, id) {
  const a = APPS[id];
  if (!a) return win.loadFile(path.join(__dirname, 'launcher.html'));
  if (a.kind === 'offline') {
    win.loadURL(`app://${a.host}/`);
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`app://${a.host}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
    win.on('focus', () => win.webContents.executeJavaScript('window.CBSync && window.CBSync.kick()').catch(() => {}));
    return;
  }
  const server = (readCfg().servers || {})[id];
  if (!server) return setupPage(win, id);
  win.loadURL(server + '/');
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) setupPage(win, id, `Couldn't reach ${server} (${desc}). Check the address, and that Tailscale is on if you're away from home.`); });
  win.webContents.on('will-navigate', (e, url) => { const s = (readCfg().servers || {})[id] || ''; if (s && !url.startsWith(s) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
}

ipcMain.handle('rc:info', () => ({ suite: SUITE.name, version: app.getVersion(), apps: SUITE.apps.map(a => ({ id: a.id, name: a.name, kind: a.kind, desc: a.desc })), servers: readCfg().servers || {} }));
ipcMain.handle('rc:open', (e, id) => { openApp(id); return true; });
ipcMain.handle('rc:setServer', async (e, id, url) => {
  if (!APPS[id] || APPS[id].kind !== 'server') return { error: 'Unknown app' };
  url = cleanUrl(url); if (!url) return { error: 'Type the address first' };
  try {
    const r = await net.fetch(url + '/healthz', { method: 'GET' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (err) { return { error: `Couldn't reach ${url}. Check the address, and that Tailscale is on if you're away from home. (${err.message})` }; }
  const c = readCfg(); c.servers = c.servers || {}; c.servers[id] = url; writeCfg(c);
  const w = wins[id]; if (w && !w.isDestroyed()) load(w, id);
  return { ok: true, url };
});
ipcMain.handle('rc:clearServer', (e, id) => { const c = readCfg(); if (c.servers) delete c.servers[id]; writeCfg(c); const w = wins[id]; if (w && !w.isDestroyed()) setupPage(w, id); return true; });

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url); const root = HOSTS[u.hostname];
    if (!root) return new Response('Not found', { status: 404 });
    let p = decodeURIComponent(u.pathname); if (p === '/' || p === '') p = '/index.html';
    let f = path.normalize(path.join(root, p));
    if (!f.startsWith(root)) return new Response('Not found', { status: 404 });
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (path.extname(p)) return new Response('Not found', { status: 404 });
      f = fs.existsSync(f + '.html') ? f + '.html' : path.join(root, 'index.html');
    }
    return new Response(fs.readFileSync(f), { headers: { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  });
  // Camera (barcode scanning), clipboard and notifications are allowed; everything else is refused.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen'].includes(perm)));
  openApp(argApp(process.argv) || (SUITE.apps.length === 1 ? SUITE.apps[0].id : 'launcher'));
});
app.on('second-instance', (e, argv) => openApp(argApp(argv) || (SUITE.apps.length === 1 ? SUITE.apps[0].id : 'launcher')));
app.on('window-all-closed', () => app.quit());

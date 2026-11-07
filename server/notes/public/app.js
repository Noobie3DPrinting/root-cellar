'use strict';
// Notes front end. Notes are plain text and are never trimmed or reformatted:
// every space, tab and blank line is saved exactly as typed.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const mobile = () => matchMedia('(max-width: 860px)').matches;
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHECK_RE = /^(\s*)([-*+]) \[( |x|X)\] ?/;

const S = {
  me: null, users: {}, notes: new Map(), since: 0, view: 'mine', tag: null, query: '',
  current: null, pending: {}, inflight: new Set(), prefs: {}, online: true, preview: {},
};

// ---------- storage (best effort) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
const cacheKey = () => `notes-cache:${S.me.id}`;
const pendKey = () => `notes-pending:${S.me.id}`;
let cacheTimer;
function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    store.set(cacheKey(), { since: S.since, notes: [...S.notes.values()] });
    store.set(pendKey(), S.pending);
  }, 400);
}

// ---------- installed app (Windows / Android) ----------
// The installed apps carry their own copy of these screens and sign in with a token, so they open even when the server is down.
const NATIVE = window.NOTES_NATIVE || null;
const serverBase = () => (NATIVE ? String(store.get('notes-server', '') || NATIVE.defaultServer || '').replace(/\/+$/, '') : '');
const appToken = () => (NATIVE ? store.get('notes-token', null) : null);

// ---------- api ----------
async function api(method, url, body, raw) {
  const opts = { method, headers: { 'X-Notes': '1' }, credentials: NATIVE ? 'omit' : 'same-origin', cache: 'no-store' };
  const tk = appToken(); if (tk) opts.headers.Authorization = 'Bearer ' + tk;
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  // Give up after a while so an unreachable server is treated as "offline" instead of hanging.
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), raw ? 120000 : 12000); opts.signal = ctrl.signal;
  let r;
  try { r = await fetch(serverBase() + url, opts); } finally { clearTimeout(timer); }
  let data = null;
  try { data = await r.json(); } catch { }
  if (r.status === 401 && url !== '/api/login') { showAuth(false); throw new Error('Signed out'); }
  if (!r.ok) { const e = new Error((data && data.error) || `Error ${r.status}`); e.status = r.status; throw e; }
  return data;
}

// ---------- toast / confirm ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function confirmBox(text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const d = $('#confirmDlg'); $('#confirmText').textContent = text; $('#confirmYes').textContent = okLabel;
    const done = (v) => { d.close(); resolve(v); };
    $('#confirmYes').onclick = () => done(true); $('#confirmNo').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

// ---------- time ----------
function when(ms) {
  const d = new Date(ms), n = new Date(), diff = (n - d) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}
const fullDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---------- auth ----------
async function boot() {
  applyPrefs(store.get('notes-prefs', {}));
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  if (NATIVE && !appToken()) {
    const last = store.get('notes-last-user', null);
    return showAuth(false, last ? 'Sign in again to keep syncing.' : null);
  }
  let st;
  try { st = await api('GET', '/api/status'); }
  catch {
    // offline: open from the cached copy if we have one
    const last = store.get('notes-last-user', null);
    if (last) { S.me = last; return startApp(true); }
    return showAuth(false, 'Can’t reach the notes server. Check your connection.');
  }
  if (st.setupNeeded) return showAuth(true);
  if (!st.user) return showAuth(false);
  S.me = st.user; startApp(false);
}
function showAuth(setup, msg) {
  $('#app').hidden = true; $('#auth').hidden = false;
  $('#displayWrap').hidden = !setup;
  $('#serverWrap').hidden = !NATIVE;
  if (NATIVE) $('#authServer').value = serverBase();
  $('#authIntro').textContent = setup ? 'Welcome! Create your account to get started. You can add other people later in Settings.' : (msg || 'Sign in to your notes.');
  $('#authBtn').textContent = setup ? 'Create account' : 'Sign in';
  $('#authPass').autocomplete = setup ? 'new-password' : 'current-password';
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault(); $('#authError').textContent = '';
    const body = { username: $('#authUser').value, password: $('#authPass').value, display_name: $('#authDisplay').value };
    if (NATIVE) { store.set('notes-server', $('#authServer').value.trim().replace(/\/+$/, '')); store.del('notes-token'); body.app = true; }
    try {
      const r = await api('POST', setup ? '/api/setup' : '/api/login', body);
      if (NATIVE && r && r.token) store.set('notes-token', r.token);
      location.reload();
    } catch (err) { $('#authError').textContent = err.name === 'AbortError' || err instanceof TypeError ? (NATIVE ? `Can't reach ${serverBase()}. Check the address and that Tailscale is on.` : 'Can’t reach the notes server.') : err.message; }
  };
  setTimeout(() => (setup ? $('#authDisplay') : $('#authUser')).focus(), 50);
}

// ---------- app start ----------
function startApp(offline) {
  $('#auth').hidden = true; $('#app').hidden = false;
  store.set('notes-last-user', S.me);
  S.prefs = { theme: 'auto', font: 'sans', size: 'm', sort: 'modified', ...store.get('notes-prefs', {}), ...(S.me.prefs || {}) };
  applyPrefs(S.prefs);
  S.preview = store.get('notes-preview', {});
  const cached = store.get(cacheKey(), null);
  if (cached) { S.since = cached.since; for (const n of cached.notes) S.notes.set(n.id, n); }
  S.pending = store.get(pendKey(), {});
  $('#whoami').textContent = `Signed in as ${S.me.display_name}`;
  bindUI();
  renderAll();
  if (!mobile()) { const first = visibleNotes()[0]; if (first) openNote(first.id); }
  if (!offline) loadUsers();
  sync();
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); else flushAll(); });
  addEventListener('online', sync);
  addEventListener('pagehide', flushAll);
}
async function loadUsers() {
  try { const us = await api('GET', '/api/users'); S.users = Object.fromEntries(us.map((u) => [u.id, u.display_name])); store.set('notes-users', S.users); renderPeople(us); }
  catch { S.users = store.get('notes-users', {}); }
}
const nameOf = (id) => (id === S.me.id ? 'you' : S.users[id] || 'someone');

// ---------- sync ----------
let syncing = false;
async function sync() {
  if (syncing) return; syncing = true;
  try {
    await flushAll();
    const r = await api('GET', `/api/notes?since=${S.since}`);
    for (const n of r.notes) mergeRemote(n);
    for (const id of r.removed) { if (!S.pending[id]) { S.notes.delete(id); if (S.current === id) closeEditor(); } }
    S.since = r.now;
    setOnline(true);
    saveCache();
    if (r.notes.length || r.removed.length) renderAll();
  } catch (e) { if (e.message !== 'Signed out') setOnline(false); }
  finally { syncing = false; }
}
function mergeRemote(n) {
  const local = S.notes.get(n.id);
  const busy = S.pending[n.id] || S.inflight.has(n.id);
  if (local && busy) {
    // keep what's being typed here; remember the server's revision only after our save lands
    return;
  }
  S.notes.set(n.id, n);
  if (S.current === n.id && local && local.content !== n.content) {
    const ta = $('#editor');
    const focused = document.activeElement === ta;
    const a = ta.selectionStart, b = ta.selectionEnd, top = ta.scrollTop;
    ta.value = n.content;
    if (focused) { ta.setSelectionRange(Math.min(a, n.content.length), Math.min(b, n.content.length)); }
    ta.scrollTop = top;
    if (n.modified_by !== S.me.id) toast(`${nameOf(n.modified_by)} updated this note`);
  }
  if (S.current === n.id) renderEditorChrome();
}
function setOnline(ok) {
  S.online = ok;
  const dot = $('#syncDot');
  const waiting = Object.keys(S.pending).length;
  dot.className = 'sync-dot' + (ok ? '' : ' off');
  dot.title = ok ? 'Synced with your server' : `Offline — ${waiting ? waiting + ' change(s) will sync when you’re back' : 'showing saved copy'}`;
}

// ---------- saving ----------
const saveTimers = {};
function queue(id, fields, delay = 700) {
  S.pending[id] = { ...(S.pending[id] || {}), ...fields };
  setSaveState('dirty');
  saveCache();
  clearTimeout(saveTimers[id]);
  saveTimers[id] = setTimeout(() => flush(id), delay);
}
async function flush(id) {
  clearTimeout(saveTimers[id]);
  const fields = S.pending[id];
  const n = S.notes.get(id);
  if (!fields || !n) { delete S.pending[id]; return; }
  if (S.inflight.has(id)) { saveTimers[id] = setTimeout(() => flush(id), 300); return; }
  if (n._local && !n.content && !n.tags.length) return; // nothing worth saving yet
  delete S.pending[id];
  S.inflight.add(id);
  if (id === S.current) setSaveState('saving');
  try {
    let res;
    if (n._local) {
      res = await api('POST', '/api/notes', { id, content: n.content, tags: n.tags, shared: n.shared, pinned: n.pinned, markdown: n.markdown });
    } else {
      res = await api('PUT', `/api/notes/${encodeURIComponent(id)}`, { ...fields, base_rev: n.rev });
    }
    const cur = S.notes.get(id);
    if (cur) {
      // server fields win except anything typed while this save was in the air
      const keep = S.pending[id] || {};
      const merged = { ...res, _local: false };
      for (const k of Object.keys(keep)) merged[k] = cur[k];
      delete merged.conflict;
      S.notes.set(id, merged);
    }
    if (res.conflict) toast('Someone else edited this at the same time — their version is saved in History', 5000);
    setOnline(true);
    if (id === S.current) { setSaveState(S.pending[id] ? 'dirty' : 'saved'); renderEditorChrome(); }
    renderList();
  } catch (e) {
    if (e.status === 404) { S.notes.delete(id); if (id === S.current) closeEditor(); renderAll(); return; }
    if (e.status === 409 && n._local) { n._local = false; }
    S.pending[id] = { ...fields, ...(S.pending[id] || {}) };
    if (e.status === 403) { toast(e.message); delete S.pending[id]; sync(); }
    else { setOnline(false); if (id === S.current) setSaveState('offline'); saveTimers[id] = setTimeout(() => flush(id), 10000); }
  } finally {
    S.inflight.delete(id);
    saveCache();
  }
}
async function flushAll() { await Promise.all(Object.keys(S.pending).map((id) => flush(id))); }
function setSaveState(s) {
  const el = $('#saveState');
  el.className = s === 'dirty' || s === 'saving' ? 'dirty' : s === 'offline' ? 'err' : '';
  el.textContent = { dirty: 'Editing…', saving: 'Saving…', saved: 'Saved', offline: 'Offline — saved on this device' }[s] || '';
}

// ---------- filtering / list ----------
const prettyLine = (l) => l.replace(CHECK_RE, (m, sp, b, c) => (c === ' ' ? '☐ ' : '☑ '));
function title(n) { const l = n.content.split('\n').find((x) => x.trim()); return l ? prettyLine(l.trim()).replace(/^#{1,6}\s+/, '') || 'New note' : 'New note'; }
function snippet(n) {
  const lines = n.content.split('\n');
  const i = lines.findIndex((x) => x.trim());
  return lines.slice(i + 1).map((l) => prettyLine(l.trim())).filter(Boolean).join('\n').slice(0, 220);
}
function tokens() {
  const words = [], tags = [];
  for (const t of S.query.toLowerCase().match(/"[^"]+"|\S+/g) || []) {
    const w = t.replace(/^"|"$/g, '');
    if (w.startsWith('tag:') && w.length > 4) tags.push(w.slice(4)); else words.push(w);
  }
  return { words, tags };
}
function inView(n, view = S.view) {
  if (view === 'trash') return !!n.deleted;
  if (n.deleted) return false;
  if (view === 'mine') return !n.shared && n.owner_id === S.me.id;
  if (view === 'shared') return n.shared;
  return true;
}
function visibleNotes() {
  const { words, tags } = tokens();
  const list = [...S.notes.values()].filter((n) => {
    if (!inView(n)) return false;
    if (S.tag && !n.tags.some((t) => t.toLowerCase() === S.tag.toLowerCase())) return false;
    if (tags.length && !tags.every((t) => n.tags.some((x) => x.toLowerCase().startsWith(t)))) return false;
    if (words.length) { const hay = (n.content + '\n' + n.tags.join(' ')).toLowerCase(); if (!words.every((w) => hay.includes(w))) return false; }
    return true;
  });
  const sort = S.prefs.sort;
  list.sort((a, b) => {
    if (S.view !== 'trash' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === 'alpha') return title(a).localeCompare(title(b), undefined, { sensitivity: 'base', numeric: true });
    if (sort === 'created') return b.created - a.created;
    return S.view === 'trash' ? (b.deleted - a.deleted) : (b.modified - a.modified);
  });
  return list;
}
function hl(text, words) {
  if (!words.length) return esc(text);
  const lower = text.toLowerCase();
  const marks = [];
  for (const w of words) { let i = 0; while ((i = lower.indexOf(w, i)) > -1) { marks.push([i, i + w.length]); i += w.length; } }
  if (!marks.length) return esc(text);
  marks.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of marks) { if (a < pos) continue; out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b; }
  return out + esc(text.slice(pos));
}
function renderList() {
  const list = visibleNotes();
  const { words } = tokens();
  const ul = $('#noteList');
  ul.innerHTML = list.map((n) => {
    let snip = snippet(n);
    if (words.length) {
      const body = n.content.replace(/\s+/g, ' ');
      const i = body.toLowerCase().indexOf(words[0]);
      if (i > 60) snip = '…' + body.slice(i - 40, i + 180);
    }
    const sharedBadge = n.shared ? `<span class="badge"><svg><use href="#i-users"/></svg>Shared</span>` : '';
    const by = n.shared && n.modified_by && n.modified_by !== S.me.id ? ` · ${esc(nameOf(n.modified_by))}` : '';
    const tagHtml = n.tags.slice(0, 3).map((t) => `<span class="mtag">${esc(t)}</span>`).join('');
    return `<li class="note-item${n.id === S.current ? ' active' : ''}" data-id="${esc(n.id)}" role="option">
      ${n.pinned && S.view !== 'trash' ? '<svg class="pin"><use href="#i-pin"/></svg>' : ''}
      <div class="t">${hl(title(n), words)}</div>
      ${snip ? `<div class="s">${hl(snip, words)}</div>` : ''}
      <div class="m"><span>${when(S.view === 'trash' ? n.deleted : n.modified)}${by}</span>${sharedBadge}${tagHtml}</div></li>`;
  }).join('');
  const empty = $('#emptyList');
  empty.hidden = list.length > 0;
  empty.textContent = S.query ? 'No notes match your search.' : S.view === 'trash' ? 'The trash is empty.' : S.view === 'shared' ? 'No shared notes yet. Notes you share show up here for everyone.' : 'No notes yet. Tap + to write one.';
  $('#trashBar').hidden = !(S.view === 'trash' && list.length);
}
function renderSidebar() {
  const all = [...S.notes.values()];
  const count = (v) => all.filter((n) => inView(n, v)).length || '';
  for (const v of ['all', 'mine', 'shared', 'trash']) $('#c-' + v).textContent = count(v);
  $$('#views .nav').forEach((b) => b.classList.toggle('active', !S.tag && b.dataset.view === S.view));
  const tagCounts = {};
  for (const n of all) if (!n.deleted) for (const t of n.tags) { const k = t.toLowerCase(); tagCounts[k] = tagCounts[k] || { name: t, c: 0 }; tagCounts[k].c++; }
  const tags = Object.values(tagCounts).sort((a, b) => a.name.localeCompare(b.name));
  $('#tagList').innerHTML = tags.length ? tags.map((t) => `<button class="nav${S.tag && S.tag.toLowerCase() === t.name.toLowerCase() ? ' active' : ''}" data-tag="${esc(t.name)}"><svg><use href="#i-tag"/></svg><span>${esc(t.name)}</span><b class="count">${t.c}</b></button>`).join('')
    : '<p class="hint" style="padding:0 12px">Add tags to a note to sort them here.</p>';
  $('#tagSuggest').innerHTML = tags.map((t) => `<option value="${esc(t.name)}">`).join('');
  $('#viewTitle').textContent = S.tag ? '#' + S.tag : { all: 'All notes', mine: 'My notes', shared: 'Shared', trash: 'Trash' }[S.view];
}
function renderAll() { renderSidebar(); renderList(); if (S.current) renderEditorChrome(); }

// ---------- editor ----------
function openNote(id, push = true) {
  const n = S.notes.get(id);
  if (!n) return;
  if (S.current && S.current !== id) leaveNote(S.current);
  S.current = id;
  $('#noNote').hidden = true; $('#editorWrap').hidden = false;
  const ta = $('#editor');
  ta.value = n.content;
  ta.scrollTop = 0;
  ta.readOnly = !!n.deleted;
  setSaveState(S.pending[id] ? 'dirty' : '');
  showPreview(!!S.preview[id] && !n._local);
  renderEditorChrome();
  renderList();
  if (mobile()) {
    $('#app').classList.add('editing');
    if (push) history.pushState({ note: id }, '');
  }
  if (n._local) setTimeout(() => ta.focus(), mobile() ? 260 : 0);
}
function leaveNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  if (n._local && !n.content && !n.tags.length) { S.notes.delete(id); delete S.pending[id]; return; }
  if (S.pending[id]) flush(id);
}
function closeEditor() {
  if (S.current) leaveNote(S.current);
  S.current = null;
  $('#editorWrap').hidden = true; $('#noNote').hidden = false;
  $('#app').classList.remove('editing');
  renderAll();
}
function renderEditorChrome() {
  const n = S.notes.get(S.current);
  if (!n) return;
  const mine = n.owner_id === S.me.id;
  const sb = $('#shareBtn');
  sb.classList.toggle('shared', n.shared);
  sb.innerHTML = n.shared ? `<svg><use href="#i-users"/></svg>Shared${mine ? '' : `<span class="by"> by ${esc(nameOf(n.owner_id))}</span>`}` : `<svg><use href="#i-lock"/></svg>Private`;
  sb.disabled = !mine || !!n.deleted;
  $('#pinBtn').classList.toggle('on', n.pinned);
  $('#mdState').textContent = n.markdown ? 'On' : 'Off';
  $('#trashedBanner').hidden = !n.deleted;
  $('#trashBtn').hidden = !!n.deleted;
  $('#tagChips').innerHTML = n.tags.map((t, i) => `<span class="tchip">${esc(t)}<button data-i="${i}" aria-label="Remove tag ${esc(t)}"><svg><use href="#i-x"/></svg></button></span>`).join('');
  $('#tagInput').hidden = !!n.deleted;
  const words = (n.content.match(/\S+/g) || []).length;
  const parts = [];
  if (!n._local) parts.push(`Created ${fullDate(n.created)}`);
  if (!n._local && n.modified !== n.created) parts.push(`Edited ${when(n.modified)}${n.shared && n.modified_by ? ' by ' + nameOf(n.modified_by) : ''}`);
  parts.push(`${words} word${words === 1 ? '' : 's'}`, `${n.content.length} characters`);
  $('#meta').textContent = parts.join(' · ');
  if (!$('#preview').hidden) renderPreview();
}
function onType() {
  const n = S.notes.get(S.current);
  if (!n || n.deleted) return;
  n.content = $('#editor').value; // stored exactly — no trimming, no cleanup
  n.modified = Date.now();
  n.modified_by = S.me.id;
  queue(n.id, { content: n.content });
  renderList();
  renderEditorChrome();
}
function setField(fields) {
  const n = S.notes.get(S.current);
  if (!n) return;
  Object.assign(n, fields);
  queue(n.id, fields, 50);
  renderAll();
}
function newNote() {
  const id = crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63], '');
  if (S.view === 'trash') S.view = 'mine';
  const t = Date.now();
  const n = { id, owner_id: S.me.id, shared: S.view === 'shared', content: '', tags: S.tag ? [S.tag] : [], pinned: false, markdown: false,
    created: t, modified: t, deleted: null, rev: 0, modified_by: S.me.id, _local: true };
  S.notes.set(id, n);
  if (S.query) { S.query = ''; $('#search').value = ''; }
  renderAll();
  openNote(id);
  showPreview(false);
  $('#editor').focus();
}

// insert text keeping the browser's undo history when possible
function insertText(text) {
  const ta = $('#editor');
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  onType();
}
function toggleChecklist() {
  const n = S.notes.get(S.current);
  if (!n || n.deleted) return;
  const ta = $('#editor');
  if (!$('#preview').hidden) {
    showPreview(false);
    const v = ta.value;
    ta.focus();
    ta.setSelectionRange(v.length, v.length);
    insertText((v && !v.endsWith('\n') ? '\n' : '') + '- [ ] ');
    return;
  }
  ta.focus();
  const v = ta.value;
  const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let end = v.indexOf('\n', ta.selectionEnd); if (end < 0) end = v.length;
  const lines = v.slice(start, end).split('\n');
  const allChecks = lines.every((l) => CHECK_RE.test(l) || !l.trim());
  const out = lines.map((l) => {
    if (allChecks) return l.replace(CHECK_RE, '$1');
    if (CHECK_RE.test(l) || (!l.trim() && lines.length > 1)) return l;
    const m = l.match(/^(\s*)(?:[-*+] )?(.*)$/);
    return `${m[1]}- [ ] ${m[2]}`;
  }).join('\n');
  ta.setSelectionRange(start, end);
  insertText(out);
}
function onEditorKey(e) {
  const ta = e.target;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (!e.shiftKey) insertText('\t');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && ta.selectionStart === ta.selectionEnd) {
    const v = ta.value, pos = ta.selectionStart;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(ls, pos);
    const m = line.match(CHECK_RE);
    if (m) {
      e.preventDefault();
      if (line.slice(m[0].length).trim() === '' && v.slice(pos, (v.indexOf('\n', pos) + 1 || v.length + 1) - 1).trim() === '') {
        ta.setSelectionRange(ls, pos); insertText(m[1]); // empty item ends the list
      } else insertText('\n' + m[1] + m[2] + ' [ ] ');
    }
  }
}

// ---------- preview (checklists tappable in every note; markdown when turned on) ----------
function inline(s) {
  let h = esc(s);
  const codes = [];
  h = h.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
  h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
function checkItem(m, text, idx, md) {
  const done = m[3].toLowerCase() === 'x';
  return `<div class="cl${done ? ' done' : ''}" data-line="${idx}" role="checkbox" aria-checked="${done}" style="padding-left:${m[1].replace(/\t/g, '    ').length * 0.5}em"><span class="box"></span><span class="txt">${md ? inline(text) : linkify(text)}</span></div>`;
}
function renderPreview() {
  const n = S.notes.get(S.current);
  if (!n) return;
  const lines = n.content.split('\n');
  let html = '';
  if (!n.markdown) {
    // one block per line so blank lines, leading spaces and tabs all show exactly
    lines.forEach((l, i) => { const m = l.match(CHECK_RE); html += m ? checkItem(m, l.slice(m[0].length), i, false) : `<div class="plain">${l ? linkify(l) : '&#8203;'}</div>`; });
  } else {
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (/^```/.test(l)) {
        const code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++; html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { html += '<hr>'; i++; continue; }
      if ((m = l.match(CHECK_RE))) { html += checkItem(m, l.slice(m[0].length), i, true); i++; continue; }
      if (/^>\s?/.test(l)) {
        const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        html += `<blockquote><p>${q.map(inline).join('\n')}</p></blockquote>`; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l); const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !CHECK_RE.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        html += `<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`; continue;
      }
      // paragraph: keep the original line breaks and spacing
      const p = []; while (i < lines.length && lines[i] !== '' && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) p.push(lines[i++]);
      if (p.length) html += `<p>${p.map(inline).join('\n')}</p>`;
      else { html += '<p>\n</p>'; i++; }
    }
  }
  $('#preview').innerHTML = html || '<p class="muted">Empty note</p>';
}
function showPreview(on) {
  $('#preview').hidden = !on; $('#editor').hidden = on;
  $('#previewBtn').classList.toggle('on', on);
  $('#previewBtn').innerHTML = `<svg><use href="#i-${on ? 'edit' : 'eye'}"/></svg>`;
  $('#previewBtn').title = on ? 'Edit (Alt+P)' : 'Preview — tap checklist boxes (Alt+P)';
  if (S.current) { if (on) S.preview[S.current] = 1; else delete S.preview[S.current]; store.set('notes-preview', S.preview); }
  if (on) renderPreview();
}
function toggleCheckLine(idx) {
  const n = S.notes.get(S.current);
  if (!n || n.deleted) return;
  const lines = n.content.split('\n');
  lines[idx] = lines[idx].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
  $('#editor').value = lines.join('\n');
  onType();
}

// ---------- copy (exact text, every space kept) ----------
async function copyNote() {
  const n = S.notes.get(S.current); if (!n) return;
  try { await navigator.clipboard.writeText(n.content); }
  catch {
    const ta = $('#editor'), hidden = ta.hidden; ta.hidden = false;
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.select(); document.execCommand('copy'); ta.setSelectionRange(a, b); ta.hidden = hidden;
  }
  toast('Copied — spacing and line breaks included');
}

// ---------- history ----------
async function openHistory() {
  const n = S.notes.get(S.current);
  if (!n || n._local) return toast('History starts after the first save');
  await flush(n.id);
  const d = $('#historyDlg');
  $('#histList').innerHTML = '<li>Loading…</li>'; $('#histText').textContent = ''; $('#histRestore').disabled = true;
  d.showModal();
  let vs;
  try { vs = await api('GET', `/api/notes/${encodeURIComponent(n.id)}/versions`); }
  catch (e) { $('#histList').innerHTML = `<li>${esc(e.message)}</li>`; return; }
  $('#histList').innerHTML = vs.map((v, i) => `<li data-i="${i}">${esc(fullDate(v.saved_at))}<small>${i === 0 ? 'Current · ' : ''}${esc(v.saved_by || '')} · ${(v.content.match(/\S+/g) || []).length} words</small></li>`).join('') || '<li>No history yet</li>';
  $('#histList').onclick = (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    $$('#histList li').forEach((x) => x.classList.toggle('on', x === li));
    const v = vs[li.dataset.i];
    $('#histText').textContent = v.content;
    $('#histRestore').disabled = v.content === n.content || !!n.deleted;
    $('#histRestore').onclick = () => {
      $('#editor').value = v.content; onType(); flush(n.id); d.close(); if (!$('#preview').hidden) renderPreview(); toast('Restored that version');
    };
  };
  $('#histList li[data-i="1"], #histList li[data-i="0"]')?.click();
}

// ---------- trash ----------
function trashNote() {
  const n = S.notes.get(S.current); if (!n) return;
  if (n._local && !n.content) { closeEditor(); return; }
  const id = n.id;
  n.deleted = Date.now();
  queue(id, { deleted: true }, 0);
  const next = visibleNotes()[0];
  if (mobile()) history.back(); else if (next) openNote(next.id); else closeEditor();
  renderAll();
  toast('Moved to trash');
}
function restoreNote() {
  const n = S.notes.get(S.current); if (!n) return;
  n.deleted = null; $('#editor').readOnly = false;
  queue(n.id, { deleted: false }, 0); renderAll(); toast('Restored');
}
async function purgeNote() {
  const n = S.notes.get(S.current); if (!n) return;
  if (!(await confirmBox('Delete this note forever? This can’t be undone.', 'Delete forever'))) return;
  try { await flush(n.id); await api('DELETE', `/api/notes/${encodeURIComponent(n.id)}`); S.notes.delete(n.id); if (mobile()) history.back(); closeEditor(); saveCache(); }
  catch (e) { toast(e.message); }
}
async function emptyTrash() {
  const count = [...S.notes.values()].filter((n) => n.deleted).length;
  if (!(await confirmBox(`Permanently delete ${count} note${count === 1 ? '' : 's'} in the trash?`, 'Empty trash'))) return;
  try { await flushAll(); await api('POST', '/api/trash/empty'); for (const [id, n] of S.notes) if (n.deleted) S.notes.delete(id); if (S.current && !S.notes.get(S.current)) closeEditor(); renderAll(); saveCache(); }
  catch (e) { toast(e.message); }
}

// ---------- settings ----------
function applyPrefs(p) {
  const r = document.documentElement;
  if (p.theme && p.theme !== 'auto') r.dataset.theme = p.theme; else delete r.dataset.theme;
  r.dataset.font = p.font || 'sans';
  r.dataset.size = p.size || 'm';
  $$('.seg').forEach((seg) => $$('button', seg).forEach((b) => b.classList.toggle('on', (p[seg.dataset.pref] || { theme: 'auto', font: 'sans', size: 'm', sort: 'modified' }[seg.dataset.pref]) === b.dataset.v)));
}
function renderPeople(us) {
  $('#peopleList').innerHTML = us.map((u) => `<li>${esc(u.display_name)} <span>@${esc(u.username)}${u.id === S.me.id ? ' (you)' : ''}</span></li>`).join('');
}
async function doImport(files) {
  const out = $('#importResult');
  let added = 0, updated = 0, skipped = 0;
  out.textContent = 'Importing…';
  try {
    for (const f of files) {
      const r = await api('POST', `/api/import?name=${encodeURIComponent(f.name)}`, undefined, f);
      added += r.added; updated += r.updated; skipped += r.skipped;
    }
    out.textContent = `Done: ${added} added${updated ? `, ${updated} updated` : ''}${skipped ? `, ${skipped} already here` : ''}. They’re in My notes (private).`;
    await sync();
  } catch (e) { out.textContent = e.message; }
}

// ---------- events ----------
function bindUI() {
  $('#views').onclick = (e) => { const b = e.target.closest('[data-view]'); if (!b) return; S.view = b.dataset.view; S.tag = null; afterNav(); };
  $('#tagList').onclick = (e) => { const b = e.target.closest('[data-tag]'); if (!b) return; S.tag = b.dataset.tag; S.view = 'all'; afterNav(); };
  $('#noteList').onclick = (e) => { const li = e.target.closest('.note-item'); if (li) openNote(li.dataset.id); };
  $('#search').oninput = (e) => { S.query = e.target.value; renderList(); };
  $('#newBtn').onclick = newNote; $('#fab').onclick = newNote;
  $('#menuBtn').onclick = () => $('#app').classList.add('drawer');
  $('#scrim').onclick = () => $('#app').classList.remove('drawer');
  $('#backBtn').onclick = () => history.back();
  addEventListener('popstate', () => { if (mobile() && S.current) closeEditor(); });

  const ta = $('#editor');
  ta.addEventListener('input', onType);
  ta.addEventListener('keydown', onEditorKey);
  ta.addEventListener('blur', () => S.current && S.pending[S.current] && flush(S.current));

  $('#preview').onclick = (e) => { const c = e.target.closest('.cl'); if (c && !e.target.closest('a')) toggleCheckLine(+c.dataset.line); };
  $('#previewBtn').onclick = () => showPreview($('#preview').hidden);
  $('#checkBtn').onclick = toggleChecklist;
  $('#pinBtn').onclick = () => { const n = S.notes.get(S.current); if (n) setField({ pinned: !n.pinned }); };
  $('#shareBtn').onclick = async () => {
    const n = S.notes.get(S.current); if (!n) return;
    if (!n.shared || await confirmBox('Make this note private? Others will no longer see it.', 'Make private')) {
      setField({ shared: !n.shared }); toast(n.shared ? 'Shared — everyone here can see and edit it' : 'Private — only you can see it');
    }
  };
  $('#copyBtn').onclick = copyNote;
  $('#moreBtn').onclick = (e) => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('#moreMenu')) $('#moreMenu').hidden = true; });
  $('#mdBtn').onclick = () => { const n = S.notes.get(S.current); if (n) { setField({ markdown: !n.markdown }); if (n.markdown) showPreview(true); } $('#moreMenu').hidden = true; };
  $('#historyBtn').onclick = () => { $('#moreMenu').hidden = true; openHistory(); };
  $('#trashBtn').onclick = () => { $('#moreMenu').hidden = true; trashNote(); };
  $('#restoreBtn').onclick = restoreNote;
  $('#purgeBtn').onclick = purgeNote;
  $('#emptyTrash').onclick = emptyTrash;

  const addTag = () => {
    const n = S.notes.get(S.current); const inp = $('#tagInput');
    const parts = inp.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    inp.value = '';
    if (!n || !parts.length) return;
    const tags = [...n.tags];
    for (const p of parts) if (!tags.some((t) => t.toLowerCase() === p.toLowerCase())) tags.push(p);
    setField({ tags });
  };
  $('#tagInput').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); addTag(); }
    if (e.key === 'Backspace' && !e.target.value) { const n = S.notes.get(S.current); if (n && n.tags.length) setField({ tags: n.tags.slice(0, -1) }); }
  };
  $('#tagInput').onchange = addTag;
  $('#tagInput').onblur = addTag;
  $('#tagChips').onclick = (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; const n = S.notes.get(S.current); setField({ tags: n.tags.filter((_, i) => i !== +b.dataset.i) }); };

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); newNote(); }
      if (k === 'p' && S.current) { e.preventDefault(); showPreview($('#preview').hidden); }
      if (k === 'c' && S.current) { e.preventDefault(); toggleChecklist(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.current) flush(S.current); }
  });

  // settings
  $('#settingsBtn').onclick = () => { $('#app').classList.remove('drawer'); $('#importResult').textContent = ''; $('#settingsDlg').showModal(); loadUsers(); };
  $$('dialog [data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  $$('.seg').forEach((seg) => (seg.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.prefs[seg.dataset.pref] = b.dataset.v;
    applyPrefs(S.prefs); store.set('notes-prefs', S.prefs); renderList();
    api('PUT', '/api/prefs', S.prefs).catch(() => { });
  }));
  $('#importFile').onchange = (e) => { if (e.target.files.length) doImport([...e.target.files]); e.target.value = ''; };
  $('#backupBtn').onclick = async () => { try { await api('POST', '/api/backup'); toast('Backup saved on the server'); } catch (e) { toast(e.message); } };
  $('#addPerson').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $('#addPersonErr').textContent = '';
    try { await api('POST', '/api/users', Object.fromEntries(new FormData(f))); f.reset(); f.closest('details').open = false; toast('Added'); loadUsers(); }
    catch (err) { $('#addPersonErr').textContent = err.message; }
  };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $('#pwErr').textContent = '';
    try { await api('POST', '/api/password', Object.fromEntries(new FormData(f))); f.reset(); f.closest('details').open = false; toast('Password changed'); }
    catch (err) { $('#pwErr').textContent = err.message; }
  };
  $('#logoutBtn').onclick = async () => {
    await flushAll();
    const waiting = Object.keys(S.pending).length;
    if (waiting && !(await confirmBox(`${waiting} change(s) haven’t reached the server yet. Signing out deletes them from this device.`, 'Sign out anyway'))) return;
    try { await api('POST', '/api/logout'); } catch { }
    store.del(cacheKey()); store.del(pendKey()); store.del('notes-last-user'); store.del('notes-token');
    location.reload();
  };
}
function afterNav() {
  $('#app').classList.remove('drawer');
  renderAll();
  $('#noteList').scrollTop = 0;
  if (!mobile()) { const cur = S.notes.get(S.current); if (!cur || !inView(cur)) { const f = visibleNotes()[0]; if (f) openNote(f.id); else closeEditor(); } }
}

// Export in the installed apps: they sign in with a token, so the plain link can't be used.
document.addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('a[href="/api/export"]');
  if (!a || !NATIVE) return;
  e.preventDefault();
  try {
    toast('Preparing export…');
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch(serverBase() + '/api/export', { headers: { Authorization: 'Bearer ' + appToken() }, signal: ctrl.signal });
    if (!r.ok) throw new Error('Export needs the server');
    const blob = await r.blob(), name = `notes-${new Date().toISOString().slice(0, 10)}.zip`;
    if (window.CBAndroid && window.CBAndroid.saveFile) {
      const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      window.CBAndroid.saveFile(name, btoa(bin), 'application/zip'); return;
    }
    const url = URL.createObjectURL(blob), l = document.createElement('a'); l.href = url; l.download = name; document.body.append(l); l.click(); l.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) { toast(err.message || 'Export failed'); }
});
// Android back button: close a dialog or the open note first.
window.CBNativeBack = () => {
  const d = [...document.querySelectorAll('dialog[open]')].pop(); if (d) { d.close(); return true; }
  if (mobile() && S.current) { history.back(); return true; }
  return false;
};
window.CBSync = { kick: () => { if (S.me) sync(); } };

boot();

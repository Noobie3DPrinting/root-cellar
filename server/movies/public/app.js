'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (u, o = {}) => { const r = await fetch(u, { ...o, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body }); const j = await r.json(); if (r.status === 401 && !/\/api\/(login|setup|me)$/.test(u)) { showAuth(); throw new Error(j.error || 'Please sign in'); } if (!r.ok) throw new Error(j.error || r.status); return j; };
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const norm = s => String(s || '').replace(/[‘’']/g, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
const sortKey = t => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]/g, '');
const small = u => (u || '').replace('/t/p/w342/', '/t/p/w185/').replace('/t/p/original/', '/t/p/w185/');
const FORMATS = ['Blu-ray', '4K Ultra HD', 'Blu-ray, 4K Ultra HD', 'Blu-ray, DVD', 'Blu-ray, Digital Copy', 'Blu-ray, Digital Copy, DVD', 'DVD', 'Digital Copy'];

const S = { items: [], list: ls.get('list', 'collection'), q: '', sort: ls.get('sort', 'title'), f: ls.get('filters', {}), tote: '', who: '', user: null, feat: { storage: false, storage_label: 'Tote', ripped: false } };
const SL = () => esc(S.feat.storage_label || 'Tote');

// ---------- list ----------
async function load() {
  S.items = await api('/api/items');
  render();
}
function is4k(it) { return /4k|uhd/i.test(it.format || '') || /4k|uhd/i.test(it.edition || ''); }
function toteLabel(t) { return String(t || '').split(',').map(x => x.trim()).filter(Boolean).join(' & '); }
function filtered() {
  const q = norm(S.q);
  let a = S.items.filter(i => i.list === S.list);
  if (S.f.kind) a = a.filter(i => (i.kind || 'Movie') === S.f.kind);
  if (S.f.ripped && S.feat.ripped) a = a.filter(i => S.f.ripped === 'yes' ? i.is_ripped : !i.is_ripped);
  if (S.f.k4) a = a.filter(is4k);
  if (S.tote && S.feat.storage) a = a.filter(i => S.tote === 'none' ? !i.tote : String(i.tote).split(',').map(x => x.trim()).includes(S.tote));
  if (q) a = a.filter(i => norm(i.title).includes(q) || (i.barcode || '').includes(S.q.trim()) || norm(i.notes).includes(q) || norm(i.edition).includes(q) || norm(i.loaned_to).includes(q));
  const by = { title: (x, y) => sortKey(x.title).localeCompare(sortKey(y.title), undefined, { numeric: true }), added: (x, y) => String(y.date_added).localeCompare(String(x.date_added)), year: (x, y) => (y.year || 0) - (x.year || 0) || sortKey(x.title).localeCompare(sortKey(y.title)) };
  return a.sort(by[S.sort] || by.title);
}
function posterHTML(it, cls = '') {
  return `<div class="poster ${cls}"><div class="ph">${esc(it.title)}</div>${it.poster ? `<img loading="lazy" src="${esc(small(it.poster))}" alt="" onerror="this.remove()">` : ''}</div>`;
}
function badges(it) {
  let b = '';
  if (S.feat.ripped && it.is_ripped && it.list === 'collection') b += '<span class="b rip">RIPPED</span>';
  if (S.feat.storage && it.tote) b += `<span class="b tote">${SL().toUpperCase()} ${esc(toteLabel(it.tote))}</span>`;
  if (is4k(it)) b += '<span class="b k4">4K</span>';
  if (it.loaned_to) b += '<span class="b loan">LOANED</span>';
  return b;
}
function render() {
  const coll = S.items.filter(i => i.list === 'collection'), wish = S.items.filter(i => i.list === 'wishlist');
  $('#cntCollection').textContent = coll.length; $('#cntWishlist').textContent = wish.length;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.list === S.list));
  document.querySelectorAll('.chip[data-f]').forEach(c => c.classList.toggle('on', S.f[c.dataset.f] === c.dataset.v));
  // tote options
  const totes = [...new Set(S.items.flatMap(i => String(i.tote || '').split(',').map(x => x.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sel = $('#toteFilter');
  sel.innerHTML = `<option value="">Any ${SL().toLowerCase()}</option>${totes.map(t => `<option value="${esc(t)}">${SL()} ${esc(t)}</option>`).join('')}<option value="none">No ${SL().toLowerCase()}</option>`;
  sel.value = S.tote; sel.classList.toggle('on', !!S.tote); sel.hidden = !S.feat.storage;
  document.querySelectorAll('.chip[data-f=ripped]').forEach(c => c.hidden = !S.feat.ripped);
  $('#chips').style.display = '';
  const a = filtered();
  const rippedN = coll.filter(i => i.is_ripped).length;
  $('#stat').textContent = S.list === 'collection'
    ? `${coll.length} titles${S.feat.ripped ? ` · ${rippedN} ripped` : ''}${S.feat.storage ? ` · ${coll.filter(i => i.tote).length} with a ${S.feat.storage_label.toLowerCase()} #` : ''}${a.length !== coll.length ? ` · showing ${a.length}` : ''}`
    : `${wish.length} on the wishlist${a.length !== wish.length ? ` · showing ${a.length}` : ''}`;
  $('#grid').innerHTML = a.map(it => `<button class="card" data-id="${it.id}">${posterHTML(it)}<div class="badges">${badges(it)}</div><div class="t">${esc(it.title)}</div><div class="y">${it.year || ''}${it.kind && it.kind !== 'Movie' ? ' · ' + esc(it.kind) : ''}</div></button>`).join('');
  const e = $('#empty'); e.hidden = a.length > 0;
  e.innerHTML = S.q ? `Nothing matches “${esc(S.q)}”.<br><br><button class="btn primary" onclick="openSearch(${JSON.stringify(S.q).replace(/"/g, '&quot;')})">Look it up to add</button>` : 'Nothing here yet.';
}
$('#grid').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openDetail(+c.dataset.id); });
document.querySelectorAll('.tab').forEach(t => t.onclick = () => { S.list = t.dataset.list; ls.set('list', S.list); render(); window.scrollTo(0, 0); });
document.querySelectorAll('.chip[data-f]').forEach(c => c.onclick = () => { const f = c.dataset.f; S.f[f] = S.f[f] === c.dataset.v ? '' : c.dataset.v; ls.set('filters', S.f); render(); });
$('#toteFilter').onchange = e => { S.tote = e.target.value; render(); };
$('#q').oninput = e => { S.q = e.target.value; render(); };
$('#sort').value = S.sort; $('#sort').onchange = e => { S.sort = e.target.value; ls.set('sort', S.sort); render(); };

// ---------- sheet / toast / confirm ----------
let onSheetClose = null;
function openSheet(html, onClose) { closeScanner(); $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; $('#scrim').hidden = false; $('#sheet').scrollTop = 0; onSheetClose = onClose || null; document.body.style.overflow = 'hidden'; }
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; document.body.style.overflow = ''; closeScanner(); if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); } }
$('#sheetClose').onclick = closeSheet; $('#scrim').onclick = closeSheet;
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
function ask(msg, yes = 'Yes', no = 'No') {
  return new Promise(ok => { $('#confirmMsg').innerHTML = msg; $('#confirmYes').textContent = yes; $('#confirmNo').textContent = no; $('#confirm').hidden = false;
    $('#confirmYes').onclick = () => { $('#confirm').hidden = true; ok(true); }; $('#confirmNo').onclick = () => { $('#confirm').hidden = true; ok(false); }; });
}

// ---------- scanner ----------
let scan = { stream: null, timer: null, reader: null, done: false };
function closeScanner() {
  if (scan.timer) clearTimeout(scan.timer);
  if (scan.reader) { try { scan.reader.reset(); } catch {} }
  if (scan.stream) scan.stream.getTracks().forEach(t => t.stop());
  scan = { stream: null, timer: null, reader: null, done: true };
}
function loadZXing() { return window.ZXing ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'vendor/zxing.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function openScanner() {
  openSheet(`<h2>Scan a disc</h2>
    <div class="cam"><video id="vid" playsinline muted autoplay></video><div class="aim"></div><div class="msg" id="camMsg">Starting camera…</div></div>
    <p class="muted small" style="margin:10px 2px">Point at the barcode on the back of the case.</p>
    <div class="row"><input class="input" id="manualCode" inputmode="numeric" placeholder="Or type the barcode number"><button class="btn primary" id="manualGo">Look up</button></div>
    <button class="btn ghost block" style="margin-top:10px" id="toSearch">No barcode? Search by title</button>`);
  $('#manualGo').onclick = () => { const c = $('#manualCode').value.replace(/\D/g, ''); if (c.length >= 8) gotCode(c); };
  $('#manualCode').onkeydown = e => { if (e.key === 'Enter') $('#manualGo').click(); };
  $('#toSearch').onclick = () => openSearch('');
  const vid = $('#vid'); const msg = m => { const el = $('#camMsg'); if (el) el.textContent = m; };
  scan.done = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg(location.protocol !== 'https:' ? 'Camera needs the https (Tailscale) address' : 'Camera not available'); return; }
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('ean_13')) {
      scan.stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (scan.done) { scan.stream.getTracks().forEach(t => t.stop()); return; }
      vid.srcObject = scan.stream; await vid.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8', 'upc_e'] });
      msg('Looking for a barcode…');
      const tick = async () => {
        if (scan.done) return;
        try { const r = await det.detect(vid); if (r.length && !scan.done) return gotCode(r[0].rawValue); } catch {}
        scan.timer = setTimeout(tick, 120);
      };
      tick();
    } else {
      msg('Loading scanner…'); await loadZXing(); if (scan.done) return;
      const Z = window.ZXing; const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_E]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      scan.reader = new Z.BrowserMultiFormatReader(hints, 150);
      msg('Looking for a barcode…');
      await scan.reader.decodeFromConstraints(constraints, vid, (res) => { if (res && !scan.done) gotCode(res.getText()); });
    }
  } catch (e) { msg(e && e.name === 'NotAllowedError' ? 'Camera permission was blocked — allow it in your browser settings' : 'Camera error: ' + (e.message || e)); }
}
function gotCode(code) {
  if (scan.done && !code) return;
  closeScanner(); if (navigator.vibrate) navigator.vibrate(60);
  lookupCode(code);
}

// ---------- add flow ----------
async function lookupCode(code) {
  openSheet(`<h2>Barcode ${esc(code)}</h2><div class="spinner"></div><p class="muted small" style="text-align:center">Looking it up…</p>`);
  let r;
  try { r = await api('/api/barcode?code=' + encodeURIComponent(code)); } catch (e) { r = { code, error: e.message, candidates: [], owned: [], wishlist: [] }; }
  showAdd({ barcode: r.code || code, res: r, query: r.query || '' });
}
function openSearch(q) { showAdd({ barcode: '', res: { candidates: [], owned: [], wishlist: [] }, query: q || '', searchFirst: true }); }

function miniList(items) { return items.map(i => `<div class="mini">${i.poster ? `<img src="${esc(small(i.poster))}" onerror="this.style.visibility='hidden'">` : '<div class="mph"></div>'}<div><div><b style="display:inline">${esc(i.title)}</b> ${i.year ? `<span class="muted">(${i.year})</span>` : ''}</div><div class="muted small">${esc(i.format || '')}${i.tote ? ' · Tote ' + esc(toteLabel(i.tote)) : ''}${i.is_ripped ? ' · Ripped' : ''}</div></div><button class="btn" style="margin-left:auto;padding:8px 12px" data-open="${i.id}">Open</button></div>`).join(''); }

function showAdd(ctx) {
  const r = ctx.res; ctx.sel = 0; ctx.list = 'collection'; ctx.cands = r.candidates || [];
  const owned = r.owned && r.owned.length;
  const ownB = owned ? `<div class="banner own"><b>✓ Already in your collection</b>${miniList(r.owned)}</div><button class="btn block" id="anotherCopy">Add another copy anyway</button>` : '';
  const wishB = r.wishlist && r.wishlist.length ? `<div class="banner wish"><b>★ This is on your wishlist</b>${miniList(r.wishlist)}<button class="btn primary block" style="margin-top:10px" id="moveWish">We bought it — move to Collection</button></div>` : '';
  const simB = r.owned_similar && r.owned_similar.length && !(r.owned && r.owned.length) ? `<div class="banner own"><b>You already have a copy of this title</b>${miniList(r.owned_similar)}</div>` : '';
  const errB = r.error ? `<div class="banner err">${esc(r.error)}</div>` : '';
  const prod = r.product ? `<p class="muted small" style="margin:0 0 4px">Barcode says: “${esc(r.product)}”</p>` : '';
  openSheet(`<h2>${ctx.searchFirst ? 'Add a movie' : 'Add this disc'}</h2>${ownB}${wishB}${simB}${errB}${prod}
    <div id="addArea" ${owned ? 'hidden' : ''}><div class="row" style="margin:8px 0 12px"><input class="input" id="sq" placeholder="Search by title" value="${esc(ctx.query)}"><button class="btn" id="sgo">Search</button></div>
    <div id="cands"></div>
    <div id="addForm"></div></div>`);
  if ($('#anotherCopy')) $('#anotherCopy').onclick = () => { $('#addArea').hidden = false; $('#anotherCopy').remove(); };
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openDetail(+b.dataset.open));
  if ($('#moveWish')) $('#moveWish').onclick = async () => {
    const w = r.wishlist[0];
    await api('/api/items/' + w.id, { method: 'PUT', body: { list: 'collection', date_added: new Date().toISOString().replace('T', ' ').slice(0, 19), barcode: w.barcode || ctx.barcode, added_by: '' } });
    await load(); toast(`Moved “${w.title}” to the collection`); openDetail(w.id);
  };
  const doSearch = async () => {
    const q = $('#sq').value.trim(); if (!q) return;
    $('#cands').innerHTML = '<div class="spinner"></div>';
    const yr = (q.match(/\b(19|20)\d\d\b/) || [])[0];
    const res = await api('/api/search?q=' + encodeURIComponent(q.replace(/\b(19|20)\d\d\b/, '').trim() || q) + (yr ? '&year=' + yr : '')).catch(e => ({ error: e.message }));
    ctx.cands = Array.isArray(res) ? res : []; ctx.sel = 0; ctx.searchErr = res.error;
    drawCands(ctx);
  };
  $('#sgo').onclick = doSearch; $('#sq').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  if (ctx.searchFirst && ctx.query) doSearch(); else drawCands(ctx);
  if (ctx.searchFirst && !ctx.query) setTimeout(() => $('#sq').focus(), 250);
}
function drawCands(ctx) {
  const c = ctx.cands;
  $('#cands').innerHTML = c.length ? `<div class="cands">${c.map((x, i) => `<button class="cand ${i === ctx.sel ? 'sel' : ''}" data-i="${i}">${posterHTML(x)}<div class="t">${esc(x.title)}</div><div class="y">${x.year || ''}${x.media_type === 'tv' ? ' · TV' : ''}</div></button>`).join('')}</div>`
    : `<p class="muted small">${ctx.searchErr ? esc(ctx.searchErr) : (ctx.query || $('#sq').value) ? 'No matches found — try a shorter title, or add it as typed.' : 'Type a title above.'}</p>`;
  document.querySelectorAll('.cand').forEach(b => b.onclick = () => { ctx.sel = +b.dataset.i; drawCands(ctx); });
  drawForm(ctx);
}
function drawForm(ctx) {
  const x = ctx.cands[ctx.sel];
  const typed = $('#sq') ? $('#sq').value.trim() : '';
  if (!x && !typed) { $('#addForm').innerHTML = ''; return; }
  const lastTote = ls.get('lastTote', '');
  $('#addForm').innerHTML = `<hr>
    ${x ? '' : `<p class="muted small">Adding “${esc(typed)}” without a poster.</p>`}
    <div class="seg" id="listSeg"><button data-l="collection" class="${ctx.list === 'collection' ? 'on' : ''}">Collection</button><button data-l="wishlist" class="${ctx.list === 'wishlist' ? 'on' : ''}">Wishlist</button></div>
    <div class="grid2">
      <div><label class="f">Format</label><select id="fFormat">${FORMATS.map(f => `<option ${f === ls.get('lastFormat', 'Blu-ray') ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      ${S.feat.storage ? `<div><label class="f">${SL()} #</label><input class="input" id="fTote" inputmode="numeric" placeholder="—" value="${esc(lastTote)}"></div>` : ''}
    </div>
    <label class="f">Edition (optional)</label><input class="input" id="fEdition" placeholder="Steelbook, Collector's Edition…">
    <button class="btn primary block" style="margin-top:16px" id="addGo">Add to ${ctx.list === 'collection' ? 'Collection' : 'Wishlist'}</button>`;
  document.querySelectorAll('#listSeg button').forEach(b => b.onclick = () => { ctx.list = b.dataset.l; drawForm(ctx); });
  $('#addGo').onclick = () => addItem(ctx);
}
async function addItem(ctx) {
  const x = ctx.cands[ctx.sel] || { title: $('#sq').value.trim() };
  const body = { list: ctx.list, title: x.title, year: x.year, poster: x.poster || '', overview: x.overview || '', tmdb_id: x.tmdb_id || '', imdb_id: x.imdb_id || '', media_type: x.media_type || '', kind: x.media_type === 'tv' ? 'TV' : 'Movie',
    format: $('#fFormat').value, tote: $('#fTote') ? $('#fTote').value.trim() : '', edition: $('#fEdition').value.trim(), barcode: ctx.barcode || '' };
  ls.set('lastFormat', body.format); if ($('#fTote')) ls.set('lastTote', body.tote);
  $('#addGo').disabled = true;
  const it = await api('/api/items', { method: 'POST', body });
  await load();
  toast(`Added “${it.title}” to the ${ctx.list}`);
  if (ctx.list === 'collection') {
    const nt = norm(it.title);
    const wl = S.items.filter(w => w.list === 'wishlist' && ((it.tmdb_id && w.tmdb_id === it.tmdb_id) || norm(w.title) === nt || (ctx.barcode && w.barcode === ctx.barcode)));
    for (const w of wl) {
      if (await ask(`<b>${esc(w.title)}</b> is on your wishlist.<br>Remove it from the wishlist now that you have it?`, 'Remove from wishlist', 'Keep it')) {
        await api('/api/items/' + w.id, { method: 'DELETE' }); toast('Removed from the wishlist');
      }
    }
    await load();
  }
  if (await ask(`Added <b>${esc(it.title)}</b>.<br>Scan another disc?`, 'Scan another', 'Done')) openScanner(); else closeSheet();
}

// ---------- detail ----------
async function openDetail(id) {
  openSheet('<div class="spinner"></div>');
  const it = await api('/api/items/' + id);
  const rip = it.ripped === null || it.ripped === undefined ? 'auto' : it.ripped ? 'yes' : 'no';
  const tags = [it.kind && it.kind !== 'Movie' ? it.kind : '', it.format, it.rating, it.runtime ? it.runtime + ' min' : ''].filter(Boolean).map(t => `<span class="b">${esc(t)}</span>`).join('');
  openSheet(`<div class="detail-top">${posterHTML({ ...it, poster: it.poster })}<div class="meta"><h2>${esc(it.title)}</h2><div class="muted">${it.year || ''}${it.genre ? ' · ' + esc(it.genre) : ''}</div>
      <div class="tags">${badges(it)}${tags}</div>
      ${it.list === 'collection' && S.feat.ripped ? `<div class="muted small">${it.jf ? `In Jellyfin as “${esc(it.jf_name)}”` : 'Not found in Jellyfin'}</div>` : ''}</div></div>
    ${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}
    <h3>Details</h3>
    <label class="f">Title</label><input class="input" id="dTitle" value="${esc(it.title)}">
    <div class="grid2">
      <div><label class="f">Year</label><input class="input" id="dYear" inputmode="numeric" value="${esc(it.year || '')}"></div>
      <div><label class="f">Type</label><select id="dKind">${['Movie', 'TV', 'Kids', 'Special'].map(k => `<option ${k === (it.kind || 'Movie') ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      ${S.feat.storage ? `<div><label class="f">${SL()} #</label><input class="input" id="dTote" value="${esc(it.tote || '')}" placeholder="—"></div>` : ''}
      ${S.feat.ripped ? `<div><label class="f">Ripped</label><select id="dRip"><option value="auto" ${rip === 'auto' ? 'selected' : ''}>Auto (${it.jf ? 'yes' : 'no'})</option><option value="yes" ${rip === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${rip === 'no' ? 'selected' : ''}>No</option></select></div>` : ''}
    </div>
    <label class="f">Format</label><select id="dFormat">${[...new Set([it.format, ...FORMATS].filter(Boolean))].map(f => `<option ${f === it.format ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
    <label class="f">Edition</label><input class="input" id="dEdition" value="${esc(it.edition || '')}">
    <div class="grid2">
      <div><label class="f">Barcode</label><input class="input" id="dBarcode" inputmode="numeric" value="${esc(it.barcode || '')}"></div>
      <div><label class="f">Loaned to</label><input class="input" id="dLoan" value="${esc(it.loaned_to || '')}"></div>
    </div>
    <label class="f">Notes</label><textarea id="dNotes" rows="2">${esc(it.notes || '')}</textarea>
    <div class="actions"><button class="btn primary" id="dSave">Save</button></div>
    <div class="actions">
      <button class="btn" id="dMove">${it.list === 'collection' ? 'Move to Wishlist' : 'We bought it → Collection'}</button>
      <button class="btn" id="dMatch">Fix poster / match</button>
    </div>
    <div class="actions"><button class="btn danger" id="dDel">Delete</button></div>
    <p class="muted small" style="margin-top:14px">${it.date_added ? 'Added ' + esc(String(it.date_added).slice(0, 10)) : ''}${it.added_by ? ' by ' + esc(it.added_by) : ''}${it.directors ? ' · Directed by ' + esc(it.directors) : ''}</p>`);
  $('#dSave').onclick = async () => {
    await api('/api/items/' + id, { method: 'PUT', body: { title: $('#dTitle').value.trim(), year: $('#dYear').value, kind: $('#dKind').value, ...($('#dTote') ? { tote: $('#dTote').value.trim() } : {}), ...($('#dRip') ? { ripped: $('#dRip').value } : {}), format: $('#dFormat').value, edition: $('#dEdition').value, barcode: $('#dBarcode').value.trim(), loaned_to: $('#dLoan').value.trim(), notes: $('#dNotes').value } });
    await load(); toast('Saved'); closeSheet();
  };
  $('#dMove').onclick = async () => {
    const to = it.list === 'collection' ? 'wishlist' : 'collection';
    await api('/api/items/' + id, { method: 'PUT', body: { list: to, ...(to === 'collection' ? { date_added: new Date().toISOString().replace('T', ' ').slice(0, 19), added_by: '' } : {}) } });
    await load(); toast(to === 'collection' ? 'Moved to the collection' : 'Moved to the wishlist'); closeSheet();
  };
  $('#dDel').onclick = async () => { if (await ask(`Delete <b>${esc(it.title)}</b>?`, 'Delete', 'Cancel')) { await api('/api/items/' + id, { method: 'DELETE' }); await load(); toast('Deleted'); closeSheet(); } };
  $('#dMatch').onclick = () => fixMatch(it);
}
async function fixMatch(it) {
  openSheet(`<h2>Pick the right movie</h2><div class="row" style="margin-bottom:12px"><input class="input" id="mq" value="${esc(it.title.replace(/\s*\(.*?\)\s*/g, ' ').trim())}"><button class="btn" id="mgo">Search</button></div><div id="mres"><div class="spinner"></div></div>`, null);
  const go = async () => {
    $('#mres').innerHTML = '<div class="spinner"></div>';
    const r = await api('/api/search?q=' + encodeURIComponent($('#mq').value) + (it.year ? '&year=' + it.year : '')).catch(e => ({ error: e.message }));
    if (!Array.isArray(r) || !r.length) { $('#mres').innerHTML = `<p class="muted">${esc(r.error || 'No matches')}</p>`; return; }
    $('#mres').innerHTML = `<div class="cands">${r.map((x, i) => `<button class="cand" data-i="${i}">${posterHTML(x)}<div class="t">${esc(x.title)}</div><div class="y">${x.year || ''}${x.media_type === 'tv' ? ' · TV' : ''}</div></button>`).join('')}</div><p class="muted small">Tapping one updates the poster and description. Your title, notes and other details stay the same.</p>`;
    document.querySelectorAll('#mres .cand').forEach(b => b.onclick = async () => {
      const x = r[+b.dataset.i];
      await api('/api/items/' + it.id, { method: 'PUT', body: { poster: x.poster, tmdb_id: x.tmdb_id, imdb_id: x.imdb_id, media_type: x.media_type, overview: x.overview || it.overview, ...(it.year ? {} : { year: x.year }) } });
      await load(); toast('Poster updated'); openDetail(it.id);
    });
  };
  $('#mgo').onclick = go; $('#mq').onkeydown = e => { if (e.key === 'Enter') go(); }; go();
}

// ---------- settings ----------
// ---------- sign-in ----------
function showAuth(setup) {
  const el = $('#auth');
  el.hidden = false;
  el.innerHTML = `<div class="auth-card">
    <div class="auth-brand"><img src="icon.svg" alt="" width="56" height="56"><div><h1>Movies</h1><div class="muted small">Root Cellar</div></div></div>
    ${setup ? `<p>Welcome! Create the first account. It becomes the admin, who can add everyone else in your home from Settings.</p>` : '<p class="muted">Sign in to see your collection.</p>'}
    <label class="f">Name</label><input class="input" id="aName" autocomplete="username" autocapitalize="words" placeholder="${setup ? 'Your name' : ''}">
    <label class="f">Password</label><input class="input" id="aPw" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'At least 6 characters' : ''}">
    <div class="auth-err" id="aErr"></div>
    <button class="btn primary block" id="aGo" style="margin-top:14px">${setup ? 'Create account' : 'Sign in'}</button>
  </div>`;
  const go = async () => {
    $('#aErr').textContent = ''; $('#aGo').disabled = true;
    try {
      await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: { name: $('#aName').value, password: $('#aPw').value } });
      el.hidden = true; await boot();
    } catch (e) { $('#aErr').textContent = e.message; $('#aGo').disabled = false; }
  };
  $('#aGo').onclick = go;
  $('#aPw').onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => $('#aName').focus(), 50);
}
async function boot() {
  let me;
  try { me = await api('/api/me'); } catch (e) { $('#empty').hidden = false; $('#empty').textContent = "Can't reach the Movies server."; return; }
  S.feat = me.features || S.feat;
  if (me.needsSetup) return showAuth(true);
  if (!me.user) return showAuth(false);
  S.user = me.user; S.who = me.user.name;
  $('#auth').hidden = true;
  await load();
}

// ---------- CSV import ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
const IMPORT_ALIASES = {
  title: ['title', 'name', 'movie', 'movie title'], year: ['year', 'release year', 'released'], list: ['list', 'collection/wishlist', 'status'],
  format: ['format', 'media', 'media type'], barcode: ['barcode', 'upc', 'ean', 'upc/ean'], tote: ['tote', 'storage location', 'location', 'shelf', 'box'],
  kind: ['kind', 'show type', 'type'], edition: ['edition'], notes: ['notes', 'note', 'comments'], loaned_to: ['loaned_to', 'loaned to', 'loaned'],
  genre: ['genre', 'genres'], rating: ['rating', 'mpaa rating'], runtime: ['runtime', 'run time'], date_added: ['date_added', 'date added', 'added'],
  purchase_price: ['purchase_price', 'purchase price', 'price'], purchase_date: ['purchase_date', 'purchase date'], purchased_from: ['purchased_from', 'purchased from', 'store'],
  imdb_id: ['imdb_id', 'imdb id', 'imdb'], tmdb_id: ['tmdb_id', 'tmdb id'], added_by: ['added_by', 'added by'], series: ['series'], season: ['season'], discs: ['discs', 'number of discs']
};
async function importCsv(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return toast('That file has no rows');
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = {};
  for (const [f, names] of Object.entries(IMPORT_ALIASES)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) idx[f] = i; }
  if (idx.title === undefined) return toast('No "Title" column found in that file');
  const items = rows.slice(1).map(r => {
    const o = {};
    for (const [f, i] of Object.entries(idx)) o[f] = (r[i] ?? '').trim();
    o.list = /wish/i.test(o.list || '') ? 'wishlist' : 'collection';
    if (o.kind && !['Movie', 'TV', 'Kids', 'Special'].includes(o.kind)) o.kind = /tv|series|show/i.test(o.kind) ? 'TV' : 'Movie';
    return o;
  }).filter(o => o.title);
  if (!(await ask(`Import <b>${items.length}</b> titles from <b>${esc(file.name)}</b>?<br><span class="muted small">Titles already in the app are skipped.</span>`, 'Import', 'Cancel'))) return;
  const r = await api('/api/import', { method: 'POST', body: { rows: items } });
  await load(); toast(`Imported ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ''}`); openSettings();
}

// ---------- settings ----------
async function openSettings() {
  const [s, users] = await Promise.all([api('/api/status'), api('/api/users')]);
  S.feat = s.features || S.feat;
  const j = s.jellyfin, b = s.backfill, admin = S.user && S.user.admin;
  openSheet(`<h2>Settings</h2>
    <div class="kv"><div>Signed in as</div><div><b>${esc(S.user.name)}</b>${admin ? ' · admin' : ''}</div></div>
    <div class="actions"><button class="btn" id="pwBtn">Change password</button><button class="btn" id="outBtn">Sign out</button></div>

    <h3>People</h3>
    <div class="people">${users.map(u => `<div class="person"><span>${esc(u.name)}${u.admin ? ' <span class="muted small">admin</span>' : ''}</span>${admin && u.id !== S.user.id ? `<span><button class="btn small-btn" data-reset="${u.id}">Reset password</button> <button class="btn small-btn danger" data-del="${u.id}">Remove</button></span>` : ''}</div>`).join('')}</div>
    ${admin ? `<div class="grid2" style="margin-top:8px"><input class="input" id="nuName" placeholder="Name" autocapitalize="words"><input class="input" id="nuPw" type="password" placeholder="Password (6+ characters)" autocomplete="new-password"></div><button class="btn block" id="nuAdd" style="margin-top:8px">Add person</button>` : '<p class="muted small">Ask an admin to add or remove people.</p>'}

    <h3>Features</h3>
    <label class="switchrow"><input type="checkbox" id="ftStorage" ${S.feat.storage ? 'checked' : ''}><span><b>Storage spots</b><br><span class="muted small">Give each disc a box, tote or shelf number and filter by it. Handy while discs are packed away.</span></span></label>
    <div class="row" id="slRow" style="margin:6px 0 4px" ${S.feat.storage ? '' : 'hidden'}><input class="input" id="ftLabel" value="${esc(S.feat.storage_label)}" placeholder="Tote, Box, Shelf…" maxlength="20"><button class="btn" id="ftLabelSave">Rename</button></div>
    <label class="switchrow"><input type="checkbox" id="ftRipped" ${S.feat.ripped ? 'checked' : ''}><span><b>Ripped badges</b><br><span class="muted small">Mark discs you've already copied to your media server. Connect Jellyfin below to do it automatically.</span></span></label>

    <h3>Jellyfin (optional)</h3>
    <div class="kv"><div>Status</div><div>${j.error ? `<span style="color:var(--red)">${esc(j.error)}</span>` : j.has_key ? `${j.items} movies & shows found` : 'Not connected'}</div><div>Last checked</div><div>${esc(j.synced_at || 'never')}</div></div>
    <p class="muted small">If you run Jellyfin, Movies can show which discs are already ripped, and use it for posters and title search. Checked every hour.</p>
    <label class="f">Jellyfin address</label>
    <div class="row" style="margin-bottom:10px"><input class="input" id="jfUrl" value="${esc(j.url || '')}" placeholder="http://192.168.1.20:8096" autocapitalize="none" spellcheck="false"><button class="btn" id="jfUrlSave">Save</button></div>
    <label class="f">Jellyfin API key ${j.has_key ? '(saved)' : ''}</label>
    <div class="row" style="margin-bottom:10px"><input class="input" id="jfKey" placeholder="${j.has_key ? 'Paste to replace' : 'Jellyfin → Dashboard → API Keys → +'}" autocapitalize="none" spellcheck="false"><button class="btn" id="jfKeySave">Save</button></div>
    ${j.has_key ? '<button class="btn block" id="jfSync">Check Jellyfin now</button>' : ''}

    <h3>Posters & title search</h3>
    <p class="muted small">${b.running ? `Finding posters… ${b.done} of ${b.total} checked, ${b.matched} found.` : 'Posters and descriptions come from TMDB (The Movie Database). Add a free TMDB key here, or connect Jellyfin above. Without either, you can still add titles by typing them.'}</p>
    <div class="row"><input class="input" id="tmdbKey" placeholder="${s.tmdb ? 'Key saved — paste to replace' : 'TMDB API key (free at themoviedb.org)'}" autocapitalize="none" spellcheck="false"><button class="btn" id="tmdbSave">Save</button></div>
    ${b.running ? '' : '<button class="btn block" id="bfRetry" style="margin-top:8px">Try again for titles without posters</button>'}

    <h3>Barcode lookups</h3>
    <p class="muted small">Scanning uses the free UPCitemdb database: ${s.upc.used} used today${s.upc.remaining !== '' ? `, ${esc(s.upc.remaining)} left` : ''} of 100. Discs already in your collection are recognized without using a lookup. Scanning needs the https:// address (see the setup guide).</p>

    <h3>Import & export</h3>
    <a class="btn block" style="text-align:center;text-decoration:none" href="/api/export.csv">Download everything as CSV</a>
    <button class="btn block" id="impBtn" style="margin-top:8px">Import a CSV file</button>
    <p class="muted small">Works with a file exported from this app, from iCollect, or a spreadsheet with a Title column.</p>
    <input type="file" id="impFile" accept=".csv,text/csv" hidden>
    <p class="muted small" style="margin-top:16px">${s.counts.collection || 0} in the collection · ${s.counts.wishlist || 0} on the wishlist. Backed up nightly on the server.</p>
    ${window.RCAndroid ? '<button class="btn block" id="chgSrv" style="margin-top:8px">Change server address</button>' : ''}
    <p class="muted small center">Root Cellar Movies · This product uses the TMDB API but is not endorsed or certified by TMDB.</p>`);
  if ($('#chgSrv')) $('#chgSrv').onclick = () => window.RCAndroid.changeServer();
  const save = async (body, msg) => { try { const r = await api('/api/settings', { method: 'PUT', body }); if (r.features) S.feat = r.features; render(); if (msg) toast(msg); } catch (e) { toast(e.message); } };
  $('#ftStorage').onchange = async e => { await save({ storage: e.target.checked }, e.target.checked ? 'Storage spots on' : 'Storage spots off'); $('#slRow').hidden = !e.target.checked; };
  $('#ftLabelSave').onclick = () => save({ storage_label: $('#ftLabel').value }, 'Renamed');
  $('#ftRipped').onchange = e => save({ ripped: e.target.checked }, e.target.checked ? 'Ripped badges on' : 'Ripped badges off');
  $('#jfUrlSave').onclick = async () => { await save({ jellyfin_url: $('#jfUrl').value.trim() }, 'Jellyfin address saved'); };
  $('#jfKeySave').onclick = async () => { const v = $('#jfKey').value.trim(); if (!v) return; await save({ jellyfin_key: v }, 'Jellyfin key saved — checking now'); setTimeout(async () => { await load(); openSettings(); }, 4000); };
  if ($('#jfSync')) $('#jfSync').onclick = async () => { $('#jfSync').disabled = true; $('#jfSync').textContent = 'Checking…'; const r = await api('/api/jellyfin/sync', { method: 'POST' }); await load(); toast(r.ok ? `Jellyfin has ${r.items} titles` : r.error); openSettings(); };
  if ($('#bfRetry')) $('#bfRetry').onclick = async () => { await api('/api/backfill?retry=1', { method: 'POST' }); toast('Looking for posters in the background'); openSettings(); };
  $('#tmdbSave').onclick = async () => { const v = $('#tmdbKey').value.trim(); if (!v) return; await save({ tmdb_key: v }, 'TMDB key saved'); openSettings(); };
  $('#impBtn').onclick = () => $('#impFile').click();
  $('#impFile').onchange = e => { const f = e.target.files[0]; if (f) importCsv(f).catch(err => toast(err.message)); };
  $('#outBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.user = null; S.items = []; closeSheet(); render(); showAuth(false); };
  $('#pwBtn').onclick = () => {
    const cur = prompt('Current password'); if (cur === null) return;
    const nw = prompt('New password (at least 6 characters)'); if (!nw) return;
    api('/api/me/password', { method: 'POST', body: { current: cur, password: nw } }).then(() => toast('Password changed')).catch(e => toast(e.message));
  };
  if ($('#nuAdd')) $('#nuAdd').onclick = async () => { try { await api('/api/users', { method: 'POST', body: { name: $('#nuName').value, password: $('#nuPw').value } }); toast('Added'); openSettings(); } catch (e) { toast(e.message); } };
  document.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => { if (await ask('Remove this person? Their discs stay in the collection.', 'Remove', 'Cancel')) { await api('/api/users/' + x.dataset.del, { method: 'DELETE' }); openSettings(); } });
  document.querySelectorAll('[data-reset]').forEach(x => x.onclick = async () => { const pw = prompt('New password for this person (at least 6 characters)'); if (!pw) return; try { await api('/api/users/' + x.dataset.reset, { method: 'PUT', body: { password: pw } }); toast('Password reset'); } catch (e) { toast(e.message); } });
}

$('#btnScan').onclick = openScanner;
$('#btnAdd').onclick = () => openSearch('');
$('#btnSettings').onclick = openSettings;
window.openSearch = openSearch;

boot();
setInterval(() => { if (S.user && $('#sheet').hidden && document.visibilityState === 'visible') load(); }, 60000);
document.addEventListener('visibilitychange', () => { if (S.user && document.visibilityState === 'visible' && $('#sheet').hidden) load(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

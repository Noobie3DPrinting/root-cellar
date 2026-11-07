'use strict';
// Root Cellar Labels — the browser draws each label on a canvas, so the preview is exactly what prints.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
async function api(u, o = {}) {
  const r = await fetch(u, { ...o, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body });
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && !/\/api\/(login|setup|me)$/.test(u)) { showAuth(false); throw new Error(j.error || 'Please sign in'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + ')');
  return j;
}
let toastT; function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

// ---------- label sizes (inches, drawn wide) ----------
// media = the page size name the DYMO LabelWriter driver uses, so CUPS picks the right label.
const SIZES = [
  { id: '30252', name: 'Address · 1⅛" × 3½" (DYMO 30252 / 99010)', w: 3.5, h: 1.125, media: 'w79h252' },
  { id: '30330', name: 'Return address · ¾" × 2" (DYMO 30330)', w: 2, h: 0.75, media: 'w54h144' },
  { id: '30336', name: 'Multipurpose · 1" × 2⅛" (DYMO 30336)', w: 2.125, h: 1, media: 'w72h154' },
  { id: '30321', name: 'Large address · 1.4" × 3½" (DYMO 30321)', w: 3.5, h: 1.4, media: 'w101h252' },
  { id: '30334', name: 'Multipurpose · 1¼" × 2¼" (DYMO 30334)', w: 2.25, h: 1.25, media: 'w90h162' },
  { id: '30332', name: 'Square · 1" × 1" (DYMO 30332)', w: 1, h: 1, media: 'w72h72' },
  { id: '30347', name: 'Book spine · 1" × 1½" (DYMO 30347)', w: 1.5, h: 1 },
  { id: '30324', name: 'Diskette · 2⅛" × 2¾" (DYMO 30324)', w: 2.75, h: 2.125 },
  { id: '30256', name: 'Shipping · 2-5⁄16" × 4" (DYMO 30256)', w: 4, h: 2.3125, media: 'w167h288' },
  { id: '30323', name: 'Shipping · 2⅛" × 4" (DYMO 30323)', w: 4, h: 2.125 },
  { id: '4x6', name: 'Shipping · 4" × 6" (DYMO 1744907, 4XL)', w: 6, h: 4 },
  { id: 'custom', name: 'Custom size…', w: 3, h: 1 }
];
const FONTS = [
  { f: 'Inter', name: 'Clean' }, { f: 'Oswald', name: 'Tall' }, { f: 'Bebas Neue', name: 'Bold caps', noBold: true },
  { f: 'Roboto Slab', name: 'Slab' }, { f: 'Merriweather', name: 'Classic' }, { f: 'Playfair Display', name: 'Elegant' },
  { f: 'Caveat', name: 'Handwritten' }, { f: 'Pacifico', name: 'Script', noBold: true }, { f: 'Comic Neue', name: 'Playful' }, { f: 'Roboto Mono', name: 'Typewriter' }
];
const BLANK = () => ({ size: ls.get('lastSize', '30252'), cw: 3, ch: 1, text: '', font: 'Inter', mode: 'auto', pt: 18, bold: false, italic: false, first: false, align: 'center', art: null, artPos: 'left', artScale: 85, border: 'none' });

const S = { user: null, printers: [], saved: [], recent: [], status: {}, L: { ...BLANK(), ...ls.get('draft', {}) }, editing: null };
const sizeOf = L => { const s = SIZES.find(x => x.id === L.size) || SIZES[0]; return s.id === 'custom' ? { ...s, w: Math.max(0.4, +L.cw || 3), h: Math.max(0.4, +L.ch || 1) } : s; };

// ---------- drawing ----------
const artCache = new Map();
function artImage(art) {
  if (!art) return Promise.resolve(null);
  const key = art.id || art.data;
  if (artCache.has(key)) return artCache.get(key);
  const src = art.id ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent((CLIPART.find(c => c.id === art.id) || {}).svg || '') : art.data;
  const p = new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });
  artCache.set(key, p); return p;
}
async function draw(canvas, L, dpi, nudge) {
  const sz = sizeOf(L), W = Math.round(sz.w * dpi), H = Math.round(sz.h * dpi);
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.save();
  if (nudge) c.translate((nudge.dx || 0) / 25.4 * dpi, (nudge.dy || 0) / 25.4 * dpi);
  const m = 0.07 * dpi; // keep clear of the edges; label printers can't print right to the edge
  // border
  if (L.border !== 'none') {
    const bw = (L.border === 'thick' ? 0.045 : 0.018) * dpi, r = L.border === 'round' ? 0.12 * dpi : 0;
    c.lineWidth = bw; c.strokeStyle = '#000';
    const x = m * 0.6 + bw / 2, y = m * 0.6 + bw / 2, w = W - 2 * x, h = H - 2 * y;
    c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); c.stroke();
  }
  const inset = L.border !== 'none' ? m * 1.5 : m;
  let box = { x: inset, y: inset, w: W - 2 * inset, h: H - 2 * inset };
  const img = await artImage(L.art);
  const lines = String(L.text || '').replace(/\s+$/, '').split('\n');
  const hasText = lines.some(l => l.trim());
  if (img) {
    const sc = (L.artScale || 85) / 100;
    const fitIn = (bx, by, bw, bh) => { const r = Math.min(bw / img.width, bh / img.height); const w = img.width * r, h = img.height * r; c.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h); };
    const pos = hasText ? L.artPos : 'only';
    if (pos === 'only') { const s = Math.min(box.w, box.h) * sc; fitIn(box.x + (box.w - s) / 2, box.y + (box.h - s) / 2, s, s); }
    else if (pos === 'behind') { c.globalAlpha = 0.16; const s = Math.min(box.w, box.h) * sc; fitIn(box.x + (box.w - s) / 2, box.y + (box.h - s) / 2, s, s); c.globalAlpha = 1; }
    else if (pos === 'top') { const h = box.h * 0.45 * sc; fitIn(box.x, box.y, box.w, h); const g = 0.04 * dpi; box = { x: box.x, y: box.y + h + g, w: box.w, h: box.h - h - g }; }
    else { const s = Math.min(box.h * sc, box.w * 0.45); const g = 0.06 * dpi; fitIn(pos === 'left' ? box.x : box.x + box.w - s, box.y + (box.h - s) / 2, s, box.h * sc > s ? s : box.h * sc); box = { x: pos === 'left' ? box.x + s + g : box.x, y: box.y, w: box.w - s - g, h: box.h }; }
  }
  if (hasText && box.w > 4 && box.h > 4) {
    const fontFor = (i, px) => `${L.italic ? 'italic ' : ''}${(L.bold && !L.first) || (L.first && i === 0) ? '700' : '400'} ${px}px "${L.font}"`;
    const gap = 1.18;
    const widest = px => Math.max(...lines.map((ln, i) => { c.font = fontFor(i, px); return c.measureText(ln).width; }));
    let px;
    if (L.mode === 'fixed') px = (L.pt || 18) / 72 * dpi;
    else {
      let lo = 2, hi = box.h / (lines.length * gap - (gap - 1));
      if (widest(hi) <= box.w) px = hi;
      else { for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (widest(mid) <= box.w) lo = mid; else hi = mid; } px = lo; }
    }
    const lh = px * gap, block = px + (lines.length - 1) * lh;
    c.fillStyle = '#000'; c.textBaseline = 'alphabetic';
    let y = box.y + (box.h - block) / 2 + px * 0.82;
    lines.forEach((ln, i) => {
      c.font = fontFor(i, px);
      c.textAlign = L.align;
      const x = L.align === 'left' ? box.x : L.align === 'right' ? box.x + box.w : box.x + box.w / 2;
      c.fillText(ln, x, y); y += lh;
    });
    return { px, pt: px / dpi * 72, overflow: L.mode === 'fixed' && (widest(px) > box.w + 1 || block > box.h + 1) };
  }
  c.restore();
  return {};
}
let drawing = null;
async function refresh() {
  ls.set('draft', S.L);
  await document.fonts.load(`700 20px "${S.L.font}"`).catch(() => {});
  await document.fonts.load(`400 20px "${S.L.font}"`).catch(() => {});
  const sz = sizeOf(S.L), cv = $('#preview'), paper = $('#paper');
  const maxW = Math.min(paper.clientWidth - 40, 560), maxH = 260;
  const scale = Math.min(maxW / sz.w, maxH / sz.h);
  const dpr = window.devicePixelRatio || 1;
  const r = await draw(cv, S.L, scale * dpr);
  cv.style.width = Math.round(sz.w * scale) + 'px'; cv.style.height = Math.round(sz.h * scale) + 'px';
  $('#dims').textContent = `${fmtIn(sz.w)} × ${fmtIn(sz.h)}${r.pt ? ` · text ${Math.round(r.pt)} pt` : ''}${r.overflow ? ' · text is too big for this label' : ''}`;
  $('#dims').classList.toggle('warn', !!r.overflow);
}
const fmtIn = v => (Math.round(v * 100) / 100) + '"';
let rT; const schedule = () => { clearTimeout(rT); rT = setTimeout(refresh, 60); };

// ---------- controls ----------
function segInit(id, key, after) {
  $$(`#${id} button`).forEach(b => b.onclick = () => { S.L[key] = b.dataset.v; syncControls(); schedule(); after && after(); });
}
function syncControls() {
  const L = S.L;
  $('#size').value = L.size; $('#customRow').hidden = L.size !== 'custom'; $('#cw').value = L.cw; $('#ch').value = L.ch;
  if ($('#text').value !== L.text) $('#text').value = L.text;
  $$('#fonts button').forEach(b => b.classList.toggle('on', b.dataset.f === L.font));
  $$('#sizeMode button').forEach(b => b.classList.toggle('on', b.dataset.v === L.mode)); $('#ptWrap').hidden = L.mode !== 'fixed';
  $('#pt').value = L.pt; $('#ptVal').textContent = L.pt + ' pt';
  $$('#style button').forEach(b => b.classList.toggle('on', !!L[b.dataset.k]));
  $$('#align button').forEach(b => b.classList.toggle('on', b.dataset.v === L.align));
  $$('#artPos button').forEach(b => b.classList.toggle('on', b.dataset.v === L.artPos));
  $('#artScale').value = L.artScale; $('#artScaleVal').textContent = L.artScale + '%';
  $$('#border button').forEach(b => b.classList.toggle('on', b.dataset.v === L.border));
  $$('#art .a').forEach(b => b.classList.toggle('on', (b.dataset.id || '') === ((L.art && L.art.id) || (L.art && L.art.data ? '__up' : ''))));
  $('#artOpts').hidden = !L.art;
}
function buildControls() {
  $('#size').innerHTML = SIZES.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#size').onchange = e => { S.L.size = e.target.value; ls.set('lastSize', S.L.size); syncControls(); schedule(); };
  $('#cw').oninput = e => { S.L.cw = +e.target.value || 3; schedule(); };
  $('#ch').oninput = e => { S.L.ch = +e.target.value || 1; schedule(); };
  $('#text').oninput = e => { S.L.text = e.target.value; schedule(); };
  $('#fonts').innerHTML = FONTS.map(f => `<button data-f="${esc(f.f)}" style="font-family:'${esc(f.f)}'" title="${esc(f.name)}"><span class="aa">Aa</span><small>${esc(f.name)}</small></button>`).join('');
  $$('#fonts button').forEach(b => b.onclick = () => { S.L.font = b.dataset.f; syncControls(); schedule(); });
  segInit('sizeMode', 'mode'); segInit('align', 'align'); segInit('artPos', 'artPos'); segInit('border', 'border');
  $('#pt').oninput = e => { S.L.pt = +e.target.value; $('#ptVal').textContent = S.L.pt + ' pt'; schedule(); };
  $$('#style button').forEach(b => b.onclick = () => { const k = b.dataset.k; S.L[k] = !S.L[k]; if (k === 'first' && S.L.first) S.L.bold = false; if (k === 'bold' && S.L.bold) S.L.first = false; syncControls(); schedule(); });
  $('#artScale').oninput = e => { S.L.artScale = +e.target.value; $('#artScaleVal').textContent = S.L.artScale + '%'; schedule(); };
  $('#art').innerHTML = `<button class="a none" data-id="" title="No picture">None</button>` +
    CLIPART.map(a => `<button class="a" data-id="${a.id}" title="${esc(a.name)}" aria-label="${esc(a.name)}">${a.svg}</button>`).join('') +
    `<button class="a up" data-id="__up" title="Use your own picture">Your<br>own…</button>`;
  $$('#art .a').forEach(b => b.onclick = () => {
    const v = b.dataset.id;
    if (v === '__up') return $('#upload').click();
    S.L.art = v ? { id: v } : null; syncControls(); schedule();
  });
  $('#upload').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { S.L.art = { data: await shrinkImage(f) }; syncControls(); schedule(); } catch { toast("Couldn't open that picture"); }
    e.target.value = '';
  };
  const setCopies = n => { $('#copies').value = Math.max(1, Math.min(99, n || 1)); };
  $('#cMinus').onclick = () => setCopies(+$('#copies').value - 1);
  $('#cPlus').onclick = () => setCopies(+$('#copies').value + 1);
  $('#copies').onchange = () => setCopies(+$('#copies').value);
  $('#printer').onchange = () => { ls.set('printer', $('#printer').value); const p = S.printers.find(x => x.id === $('#printer').value); if (p && p.size && SIZES.some(s => s.id === p.size)) { S.L.size = p.size; syncControls(); schedule(); } updateHint(); };
  $('#btnPrint').onclick = doPrint; $('#btnPdf').onclick = doPdf; $('#btnSave').onclick = doSave;
  $('#btnClear').onclick = () => { S.L = { ...BLANK(), size: S.L.size, font: S.L.font }; S.editing = null; syncControls(); refresh(); };
  window.addEventListener('resize', schedule);
}
// Pictures are shrunk and turned black-and-white so they print well on thermal printers.
function shrinkImage(file) {
  return new Promise((ok, no) => {
    const im = new Image(); const url = URL.createObjectURL(file);
    im.onload = () => {
      const k = Math.min(1, 500 / Math.max(im.width, im.height)); const cv = document.createElement('canvas');
      cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      const c = cv.getContext('2d'); c.drawImage(im, 0, 0, cv.width, cv.height);
      const d = c.getImageData(0, 0, cv.width, cv.height), p = d.data;
      for (let i = 0; i < p.length; i += 4) { const g = 0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2]; const a = p[i + 3] / 255; const v = 255 - (255 - g) * a; p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255; }
      c.putImageData(d, 0, 0); URL.revokeObjectURL(url); ok(cv.toDataURL('image/png'));
    };
    im.onerror = no; im.src = url;
  });
}

// ---------- output ----------
async function makePdf(nudge) {
  const sz = sizeOf(S.L), cv = document.createElement('canvas');
  await draw(cv, S.L, 300, nudge);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: sz.w >= sz.h ? 'landscape' : 'portrait', unit: 'in', format: [sz.w, sz.h], compress: true });
  doc.addImage(cv.toDataURL('image/png'), 'PNG', 0, 0, sz.w, sz.h, undefined, 'FAST');
  doc.setProperties({ title: (S.L.text.split('\n')[0] || 'Label').slice(0, 60) });
  return doc;
}
function labelEmpty() { return !S.L.text.trim() && !S.L.art; }
async function doPrint() {
  if (labelEmpty()) return toast('Type something or pick a picture first');
  const pr = S.printers.find(x => x.id === $('#printer').value);
  if (!pr) return toast('No printer set up yet — use Download PDF, or add one in Settings', 3500);
  const btn = $('#btnPrint'); btn.disabled = true; btn.textContent = 'Printing…';
  try {
    const doc = await makePdf({ dx: pr.dx, dy: pr.dy });
    const pdf = doc.output('datauristring');
    const copies = +$('#copies').value || 1;
    await api('/api/print', { method: 'POST', body: { printer: pr.id, pdf, copies, media: sizeOf(S.L).media || '', label: { ...S.L } } });
    toast(copies > 1 ? `Sent ${copies} copies to ${pr.name}` : `Sent to ${pr.name}`);
    loadState();
  } catch (e) { toast(e.message, 4500); }
  btn.disabled = false; btn.textContent = 'Print';
}
async function doPdf() {
  if (labelEmpty()) return toast('Type something or pick a picture first');
  const doc = await makePdf();
  const name = (S.L.text.split('\n')[0] || 'label').replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'label';
  doc.save(name + '.pdf');
}
async function doSave() {
  if (labelEmpty()) return toast('Nothing to save yet');
  const def = S.editing ? S.editing.name : (S.L.text.split('\n')[0] || 'Label').slice(0, 60);
  const name = prompt('Name this label', def); if (name === null) return;
  try { const r = await api('/api/saved', { method: 'POST', body: { id: S.editing && S.editing.name === name ? S.editing.id : undefined, name, label: S.L } }); S.editing = { id: r.id, name }; toast('Saved'); loadState(); }
  catch (e) { toast(e.message); }
}
function updateHint() {
  const pr = S.printers.find(x => x.id === $('#printer').value), st = pr && S.status.queues && S.status.queues[pr.queue];
  $('#hint').innerHTML = !S.printers.length ? 'No printer is set up on the server yet. <b>Download PDF</b> works with any printer — or an admin can add one under Settings.'
    : st && !st.ok ? `⚠ ${esc(pr.name)}: ${esc(st.state)}` : st && st.jobs ? `${esc(pr.name)}: ${st.jobs} label${st.jobs === 1 ? '' : 's'} waiting` : '';
}

// ---------- saved & recent ----------
async function thumb(L) { const cv = document.createElement('canvas'); const sz = sizeOf(L); await draw(cv, L, Math.min(130 / sz.w, 60 / sz.h) * (window.devicePixelRatio || 1)); cv.style.width = Math.round(sz.w * Math.min(130 / sz.w, 60 / sz.h)) + 'px'; return cv; }
function useLabel(L, saved) { S.L = { ...BLANK(), ...JSON.parse(JSON.stringify(L)) }; S.editing = saved ? { id: saved.id, name: saved.name } : null; showTab('design'); syncControls(); refresh(); window.scrollTo(0, 0); }
async function renderList(el, rows, kind) {
  el.innerHTML = rows.length ? '' : `<p class="empty">${kind === 'saved' ? 'Nothing saved yet. Design a label and tap <b>Save</b> to keep it here.' : 'Labels you print show up here.'}</p>`;
  for (const r of rows) {
    const L = kind === 'saved' ? r.label : r.label, row = document.createElement('div'); row.className = 'item';
    row.innerHTML = `<div class="th"></div><div class="meta"><b>${esc(kind === 'saved' ? r.name : (L.text || '').split('\n')[0] || 'Picture label')}</b><span>${esc(sizeOf(L).name.split(' (')[0])}${r.by ? ' · ' + esc(r.by) : ''}${kind === 'recent' ? ' · ' + new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span></div>
      <div class="btns"><button class="btn small" data-use>Use</button>${kind === 'saved' ? '<button class="btn small ghost" data-del aria-label="Delete">✕</button>' : ''}</div>`;
    row.querySelector('[data-use]').onclick = () => useLabel(L, kind === 'saved' ? r : null);
    const del = row.querySelector('[data-del]'); if (del) del.onclick = async () => { if (!confirm(`Delete "${r.name}"?`)) return; await api('/api/saved/' + r.id, { method: 'DELETE' }); loadState(); };
    el.appendChild(row);
    thumb(L).then(cv => row.querySelector('.th').appendChild(cv));
  }
}
function renderSaved() { const q = $('#savedQ').value.trim().toLowerCase(); renderList($('#savedList'), S.saved.filter(x => !q || (x.name + ' ' + (x.label.text || '')).toLowerCase().includes(q)), 'saved'); }
function showTab(t) { $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); ['design', 'saved', 'recent'].forEach(v => $('#' + v).hidden = v !== t); if (t === 'saved') renderSaved(); if (t === 'recent') renderList($('#recentList'), S.recent, 'recent'); }
async function loadState() {
  const st = await api('/api/state');
  S.printers = st.printers; S.saved = st.saved; S.recent = st.recent; S.status = st.status || {};
  const keep = ls.get('printer', '');
  $('#printer').innerHTML = S.printers.length ? S.printers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') : '<option value="">None yet (use Download PDF)</option>';
  if (S.printers.some(p => p.id === keep)) $('#printer').value = keep;
  updateHint();
  if (!$('#saved').hidden) renderSaved();
  if (!$('#recent').hidden) renderList($('#recentList'), S.recent, 'recent');
}

// ---------- sheet / settings ----------
let onSheetClose = null;
function openSheet(html, onClose) { $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; $('#scrim').hidden = false; $('#sheet').scrollTop = 0; onSheetClose = onClose || null; }
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); } }
$('#sheetClose').onclick = closeSheet; $('#scrim').onclick = closeSheet;
async function openSettings() {
  const users = await api('/api/users'); const admin = S.user.admin;
  openSheet(`<h2>Settings</h2>
    <div class="kv"><span>Signed in as</span><b>${esc(S.user.name)}${admin ? ' · admin' : ''}</b></div>
    <div class="actions"><button class="btn" id="pwBtn">Change password</button><button class="btn" id="outBtn">Sign out</button></div>
    <h3>Printers</h3>
    <div id="prList">${S.printers.map(p => { const st = S.status.queues && S.status.queues[p.queue]; return `<div class="person"><span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.queue)} · ${st ? esc(st.state) : (S.status.cups ? 'not found' : 'no print system')}${p.size ? ' · ' + esc((SIZES.find(s => s.id === p.size) || {}).name || '').split(' (')[0] : ''}${p.dx || p.dy ? ` · nudge ${p.dx}/${p.dy} mm` : ''}</small></span>${admin ? `<span><button class="btn small" data-edit="${p.id}">Edit</button> <button class="btn small ghost" data-rm="${p.id}">✕</button></span>` : ''}</div>`; }).join('') || '<p class="muted">No printers yet. You can always use <b>Download PDF</b> and print from your computer.</p>'}</div>
    ${admin ? `<button class="btn block" id="addPr">Add a printer</button>` : '<p class="muted small">An admin can add printers.</p>'}
    <h3>People</h3>
    <div class="people">${users.map(u => `<div class="person"><span>${esc(u.name)}${u.admin ? ' <small class="muted">admin</small>' : ''}</span>${admin && u.id !== S.user.id ? `<span><button class="btn small" data-reset="${u.id}">Reset password</button> <button class="btn small ghost" data-del="${u.id}">Remove</button></span>` : ''}</div>`).join('')}</div>
    ${admin ? `<div class="row2" style="margin-top:8px"><input class="input" id="nuName" placeholder="Name"><input class="input" id="nuPw" type="password" placeholder="Password (6+)" autocomplete="new-password"></div><button class="btn block" id="nuAdd" style="margin-top:8px">Add person</button>` : ''}
    <h3>Saved labels</h3>
    <div class="actions"><a class="btn" href="/api/export.json">Export saved labels</a><button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept=".json" hidden></div>
    ${window.RCAndroid ? '<button class="btn block" id="chgSrv">Change server address</button>' : ''}
    <p class="muted small center" style="margin-top:18px">Root Cellar Labels v${esc(S.version || '')}</p>`);
  if ($('#chgSrv')) $('#chgSrv').onclick = () => window.RCAndroid.changeServer();
  $('#outBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.user = null; closeSheet(); showAuth(false); };
  $('#pwBtn').onclick = () => { const cur = prompt('Current password'); if (cur === null) return; const nw = prompt('New password (at least 6 characters)'); if (!nw) return; api('/api/me/password', { method: 'POST', body: { current: cur, password: nw } }).then(() => toast('Password changed')).catch(e => toast(e.message)); };
  if ($('#addPr')) $('#addPr').onclick = () => printerSheet();
  $$('[data-edit]').forEach(b => b.onclick = () => printerSheet(S.printers.find(p => p.id === b.dataset.edit)));
  $$('[data-rm]').forEach(b => b.onclick = async () => { if (!confirm('Remove this printer from Labels?')) return; await api('/api/printers/' + b.dataset.rm, { method: 'DELETE' }); await loadState(); openSettings(); });
  if ($('#nuAdd')) $('#nuAdd').onclick = async () => { try { await api('/api/users', { method: 'POST', body: { name: $('#nuName').value, password: $('#nuPw').value } }); toast('Added'); openSettings(); } catch (e) { toast(e.message); } };
  $$('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Remove this person?')) return; await api('/api/users/' + b.dataset.del, { method: 'DELETE' }); openSettings(); });
  $$('[data-reset]').forEach(b => b.onclick = async () => { const pw = prompt('New password (at least 6 characters)'); if (!pw) return; try { await api('/api/users/' + b.dataset.reset, { method: 'PUT', body: { password: pw } }); toast('Password reset'); } catch (e) { toast(e.message); } });
  $('#impBtn').onclick = () => $('#impFile').click();
  $('#impFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await api('/api/import', { method: 'POST', body: JSON.parse(await f.text()) }); toast(`Imported ${r.added} labels`); loadState(); } catch (er) { toast(er.message); } };
}
async function printerSheet(pr) {
  openSheet('<h2>Looking for printers…</h2><div class="spinner"></div>');
  let d; try { d = await api('/api/printers/discover'); } catch (e) { d = { cups: false, devices: [], models: [], queues: [] }; }
  const dym = d.devices.filter(x => /dymo|label|zebra|brother|usb:/i.test(x.uri));
  openSheet(`<h2>${pr ? 'Edit printer' : 'Add a printer'}</h2>
    ${!d.cups ? `<p class="warnbox">The print system isn't running on this server, so Labels can't print directly. <b>Download PDF</b> still works. The setup guide shows how to plug the printer into the server.</p>` : ''}
    <label class="field"><span>Name shown in the app</span><input class="input" id="pName" value="${esc(pr ? pr.name : 'Label printer')}"></label>
    ${pr ? `<input type="hidden" id="pQueue" value="${esc(pr.queue)}">` : `
    <div class="field"><span>Which printer?</span>
      <select id="pSrc">
        ${dym.map(x => `<option value="new|${esc(x.uri)}">${esc(decodeURIComponent(x.uri.replace(/\?.*/, '')))}</option>`).join('')}
        ${d.queues.map(q => `<option value="queue|${esc(q.queue)}">Already set up: ${esc(q.queue)}</option>`).join('')}
        <option value="other">Other (network address)…</option>
      </select></div>
    <label class="field" id="uriRow" ${dym.length || d.queues.length ? 'hidden' : ''}><span>Printer address</span><input class="input" id="pUri" placeholder="ipp://192.168.1.50/ipp/print or socket://…" autocapitalize="none"></label>
    <div class="field" id="modelRow"><span>Printer model (driver)</span>
      <select id="pModel">${d.models.map(m => `<option value="${esc(m.ppd)}" ${/450 Turbo|lw450t/i.test(m.name + m.ppd) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}<option value="">Driverless (newer network printers)</option></select></div>
    ${dym.length || d.queues.length ? '' : `<p class="muted small">${d.cups ? 'No USB label printer found. Check it is plugged into the server and turned on, then open this again.' : ''}</p>`}
    <label class="field"><span>Roll (Twin Turbo printers only)</span><select id="pSlot"><option value="">Not a two-roll printer</option><option value="Left">Left roll</option><option value="Right">Right roll</option></select></label>
    <p class="muted small">Two-roll printers (like the LabelWriter 450 Twin Turbo): add the same printer twice, once for each roll, and give each its own name and label size.</p>`}
    <label class="field"><span>Usual label size for this printer</span><select id="pSize"><option value="">No default</option>${SIZES.filter(s => s.id !== 'custom').map(s => `<option value="${s.id}" ${pr && pr.size === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="row2"><label class="field"><span>Nudge right (mm)</span><input class="input" id="pDx" type="number" step="0.5" value="${pr ? pr.dx : 0}"></label><label class="field"><span>Nudge down (mm)</span><input class="input" id="pDy" type="number" step="0.5" value="${pr ? pr.dy : 0}"></label></div>
    <p class="muted small">If printed labels sit a little off-center, nudge them here. Negative numbers move left / up.</p>
    <button class="btn primary block" id="pSave">${pr ? 'Save' : 'Add printer'}</button>`);
  const src = $('#pSrc');
  if (src) src.onchange = () => { const v = src.value; $('#uriRow').hidden = v !== 'other'; $('#modelRow').hidden = v.startsWith('queue|'); };
  if (src && !dym.length && !d.queues.length) src.value = 'other';
  $('#pSave').onclick = async () => {
    const body = { id: pr && pr.id, name: $('#pName').value, size: $('#pSize').value, dx: +$('#pDx').value || 0, dy: +$('#pDy').value || 0 };
    if (pr) body.queue = pr.queue;
    else { const v = src.value; if (v.startsWith('queue|')) body.queue = v.slice(6); else { body.uri = v === 'other' ? $('#pUri').value.trim() : v.slice(4); body.ppd = $('#pModel').value; body.slot = $('#pSlot').value; if (!body.uri) return toast('Enter the printer address'); } }
    $('#pSave').disabled = true;
    try { await api('/api/printers', { method: 'POST', body }); toast('Printer saved'); await loadState(); openSettings(); }
    catch (e) { toast(e.message, 5000); $('#pSave').disabled = false; }
  };
}

// ---------- sign-in ----------
function showAuth(setup) {
  const el = $('#auth'); el.hidden = false;
  el.innerHTML = `<div class="auth-card"><div class="brand"><img src="icon.svg" alt="" width="44" height="44"><div><h1>Labels</h1><span class="sub">Root Cellar</span></div></div>
    <p>${setup ? 'Welcome! Create the first account. It becomes the admin, who can add printers and other people.' : 'Sign in to make labels.'}</p>
    <label class="field"><span>Name</span><input class="input" id="aName" autocomplete="username"></label>
    <label class="field"><span>Password</span><input class="input" id="aPw" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'At least 6 characters' : ''}"></label>
    <div class="err" id="aErr"></div><button class="btn primary block" id="aGo">${setup ? 'Create account' : 'Sign in'}</button></div>`;
  const go = async () => { $('#aErr').textContent = ''; try { await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: { name: $('#aName').value, password: $('#aPw').value } }); el.hidden = true; boot(); } catch (e) { $('#aErr').textContent = e.message; } };
  $('#aGo').onclick = go; $('#aPw').onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => $('#aName').focus(), 50);
}
async function boot() {
  let me; try { me = await api('/api/me'); } catch { toast("Can't reach the Labels server"); return; }
  S.version = me.version;
  if (me.needsSetup) return showAuth(true);
  if (!me.user) return showAuth(false);
  S.user = me.user; $('#auth').hidden = true;
  await loadState();
}

$$('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('#savedQ').oninput = renderSaved;
$('#btnSettings').onclick = () => S.user && openSettings();
buildControls(); syncControls(); refresh(); boot();
document.fonts.ready.then(refresh);
setInterval(() => { if (S.user && document.visibilityState === 'visible') api('/api/status').then(st => { S.status = st; updateHint(); }).catch(() => {}); }, 20000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

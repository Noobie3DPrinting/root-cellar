/* Checkbook offline engine.
 *
 * Every device keeps a full copy of the checkbook (accounts, register, bills, paydays) in IndexedDB.
 *  - Online: the app talks to the server exactly as before, and the copy is refreshed whenever anything changes.
 *  - Server unreachable: reads are answered from the copy; register entries, transfers, cleared/reconciled
 *    marks and bill payments are saved on the device and queued. Paychecks still count from 5 AM on payday
 *    and autopay bills still come out on their due date, shown as "expected" until the server confirms them.
 *  - Back online: queued changes are sent (each one exactly once), then a fresh copy is pulled.
 *    If the other person changed the same thing meanwhile, their change is kept and a note explains it.
 */
(() => {
  const NATIVE = window.CB_NATIVE || null; // set by the Windows / Android app: { platform, defaultServer }
  const LS = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: k => { try { localStorage.removeItem(k); } catch {} }
  };
  const serverBase = () => NATIVE ? String(LS.get('cb.server') || NATIVE.defaultServer || '').trim().replace(/\/+$/, '') : '';
  const token = () => NATIVE ? LS.get('cb.token') : null;

  // ---------- storage (IndexedDB, falls back to memory) ----------
  const mem = new Map();
  let dbp = null;
  const openDb = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('checkbook-offline', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const store = {
    async get(k) { try { const d = await openDb(); return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch { return mem.get(k); } },
    async set(k, v) { mem.set(k, v); try { const d = await openDb(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch {} },
    async clear() { mem.clear(); try { const d = await openDb(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch {} }
  };

  // ---------- state ----------
  const S = { snap: null, outbox: [], notes: [], lastSync: null, seq: 0, online: null, flushing: false, pulling: null, authLost: false };
  let ver = 0;
  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, x) => (listeners[ev] || []).forEach(fn => { try { fn(x); } catch (e) { console.error(e); } });
  const saveOutbox = () => { ver++; emit('status'); return store.set('outbox', S.outbox); };
  const saveMeta = () => store.set('meta', { lastSync: S.lastSync, seq: S.seq });

  const ready = (async () => {
    S.snap = (await store.get('snap')) || null;
    S.outbox = (await store.get('outbox')) || [];
    S.notes = (await store.get('notes')) || [];
    const m = (await store.get('meta')) || {};
    S.lastSync = m.lastSync || null; S.seq = m.seq || 0;
    for (const o of S.outbox) delete o.sending; // a send cut short by closing the app is simply sent again (the server ignores repeats)
  })();

  // ---------- small helpers ----------
  const pad = n => String(n).padStart(2, '0');
  const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const nowNaive = (d = new Date()) => `${today(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const rid = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };
  const nextLocalId = () => { S.seq++; saveMeta(); return 1e9 + S.seq; };
  const offlineErr = m => Object.assign(new Error(m), { offline: true });
  const isoToMs = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (iso, n) => new Date(isoToMs(iso) + n * 86400000).toISOString().slice(0, 10);
  const dayDiff = (a, b) => Math.round((isoToMs(a) - isoToMs(b)) / 86400000);
  const monthAdd = (month, k) => { const [y, m] = month.split('-').map(Number); const i = y * 12 + m - 1 + k; return `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`; };
  const dueDate = (bill, month) => { const [y, m] = month.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); let d = parseInt(bill.due, 10); if (!Number.isFinite(d)) d = 1; return `${y}-${pad(m)}-${pad(Math.max(1, Math.min(d, last)))}`; };
  const billActive = (bill, month) => ((bill.status || 'Active') === 'Active') && (!bill.ends || bill.ends >= month);
  const billLabel = bill => (bill.name || 'Bill') + (bill.item ? ` – ${bill.item}` : '');
  const words = s => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  function nameMatch(payee, bill) {
    const p = words(payee).join(' ');
    if (p.length < 3) return false;
    for (const cand of [bill.name, billLabel(bill)]) { const b = words(cand).join(' '); if (b.length >= 3 && (p.includes(b) || b.includes(p))) return true; }
    const pw = words(payee), bw = words(bill.name);
    return pw.length > 0 && bw.length > 0 && pw[0] === bw[0] && pw[0].length >= 4;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const TX_FIELDS = ['account_id', 'date', 'payee', 'category', 'memo', 'amount', 'check_no', 'status'];

  // ---------- network ----------
  async function net(path, opts = {}, timeoutMs = 10000) {
    const base = serverBase();
    if (NATIVE && !base) throw offlineErr('No server address set');
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const tk = token(); if (tk) headers.Authorization = 'Bearer ' + tk;
    try {
      const r = await fetch(base + '/api' + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal, credentials: NATIVE ? 'omit' : 'same-origin', cache: 'no-store' });
      if (r.status === 502 || r.status === 503 || r.status === 504) throw offlineErr(`The server isn't answering (${r.status})`);
      return r;
    } catch (e) {
      if (e.offline) throw e;
      throw offlineErr(e.name === 'AbortError' ? 'The server took too long to answer' : "Can't reach the server");
    } finally { clearTimeout(timer); }
  }
  function setOnline(v) {
    if (S.online === v) return;
    const was = S.online; S.online = v; ver++;
    emit('status');
    if (v && was === false) { emit('online'); kick(); }
    if (!v) emit('offline');
  }

  // ---------- derived view: last copy from the server + queued changes + expected items ----------
  let D = null, Dver = -1;
  function derived() {
    if (D && Dver === ver) return D;
    const s = S.snap;
    const tx = s.transactions.map(t => ({ ...t }));
    const bills = s.bills ? { ...s.bills, months: clone(s.bills.months || {}) } : null;
    const links = (s.bill_links || []).map(l => ({ ...l }));
    const me = s.user || {};
    const rm = pred => { for (let i = tx.length - 1; i >= 0; i--) if (pred(tx[i])) tx.splice(i, 1); };
    for (const op of S.outbox) {
      if (op.type === 'tx.create') {
        tx.push({ ...op.tx, id: op.local_id, amount: op.tx.amount_cents, transfer_id: null, created_by: me.id, entered_by: me.display_name, pending: true });
        if (op.bill_link && bills) {
          const m = op.bill_link.month; (bills.months[m] = bills.months[m] || {})[op.bill_link.bill_id] = { amount_cents: -op.tx.amount_cents, amount: -op.tx.amount_cents / 100, by: me.display_name, at: nowNaive(), pending: true };
          links.push({ month: m, bill_id: op.bill_link.bill_id, tx_id: op.local_id, amount_cents: -op.tx.amount_cents, state: 'linked' });
        }
      } else if (op.type === 'transfer.create') {
        const acc = id => (s.accounts.find(a => a.id === id) || {}).name || 'account';
        const common = { date: op.date, category: 'Transfer', memo: op.memo || '', check_no: '', status: '', transfer_id: op.transfer_id, created_by: me.id, entered_by: me.display_name, pending: true };
        tx.push({ ...common, id: op.local_ids[0], uid: op.uids[0], account_id: op.from_account_id, payee: `Transfer to ${acc(op.to_account_id)}`, amount: -op.amount_cents });
        tx.push({ ...common, id: op.local_ids[1], uid: op.uids[1], account_id: op.to_account_id, payee: `Transfer from ${acc(op.from_account_id)}`, amount: op.amount_cents });
      } else if (op.type === 'tx.update') {
        const t = tx.find(x => x.uid === op.uid); if (t) { Object.assign(t, op.changes); t.pending = true; }
      } else if (op.type === 'tx.delete') {
        const t = tx.find(x => x.uid === op.uid);
        if (t) { if (t.transfer_id) rm(x => x.transfer_id === t.transfer_id); else rm(x => x.uid === op.uid); }
      } else if (op.type === 'bill.pay' && bills) {
        const bill = bills.bills[op.bill_id]; if (!bill) continue;
        const m = op.month;
        if (op.payment) {
          (bills.months[m] = bills.months[m] || {})[op.bill_id] = { amount_cents: op.payment.amount_cents, amount: op.payment.amount_cents / 100, by: me.display_name, at: op.payment.at, pending: true };
          if (op.payment.amount_cents) tx.push({ id: op.local_id, uid: 'bill-' + op.op_id, account_id: bills.link_account, date: op.payment.at.slice(0, 10), payee: billLabel(bill).slice(0, 120), category: String(bill.category || 'Bills').slice(0, 60), memo: 'From Bill Pay', amount: -op.payment.amount_cents, check_no: '', status: '', transfer_id: null, created_by: me.id, entered_by: me.display_name, pending: true, from_bill: true });
        } else {
          if (bills.months[m]) delete bills.months[m][op.bill_id];
          const L = links.find(l => l.month === m && l.bill_id === op.bill_id && l.state === 'linked');
          if (L) { const t = tx.find(x => x.id === L.tx_id); if (t && !t.status && String(t.memo || '').startsWith('From Bill Pay')) rm(x => x === t); }
        }
      }
    }
    // Things the server does on its own at a set time, shown as "expected" while it can't be reached.
    if (S.online === false) addExpected(s, tx, bills, links);
    D = { tx, bills, links }; Dver = ver;
    return D;
  }

  function addExpected(s, tx, bills, links) {
    const t0 = today(), hour = new Date().getHours(), postHour = s.post_hour == null ? 5 : s.post_hour;
    const linkAcct = (s.link && s.link.account) || (s.accounts.find(a => !a.archived) || {}).id;
    // Paychecks entered ahead of time count from 5 AM on payday.
    for (const r of s.expected || []) {
      if (r.posted_tx_id || r.skipped || !(r.amount_cents > 0)) continue;
      if (r.date > t0 || (r.date === t0 && hour < postHour)) continue;
      const acct = s.accounts.some(a => a.id === r.account_id) ? r.account_id : linkAcct;
      tx.push({ id: 2e9 + r.id, uid: 'pay-' + r.id, account_id: acct, date: r.date, payee: r.label, category: 'Income', memo: 'Paycheck', amount: r.amount_cents, check_no: '', status: '', transfer_id: null, entered_by: 'Payday', expected: 'paycheck' });
    }
    // Autopay bills come out on their due date.
    if (!bills || !s.link || !s.link.autopay || !s.link.since) return;
    const month = t0.slice(0, 7);
    for (const [bid, b] of Object.entries(bills.bills || {})) {
      const amt = Math.round(Number(b.amount_cents) || 0);
      if (b.autopay !== 'Yes' || !amt || !billActive(b, month)) continue;
      if (bills.months[month] && bills.months[month][bid]) continue;
      if (links.some(l => l.month === month && l.bill_id === bid)) continue;
      const dd = dueDate(b, month);
      if (dd > t0 || dd < s.link.since) continue;
      (bills.months[month] = bills.months[month] || {})[bid] = { amount_cents: amt, amount: amt / 100, by: null, at: `${dd}T12:00:00`, expected: true };
      const linked = new Set(links.filter(l => l.state === 'linked').map(l => l.tx_id));
      const dup = tx.find(t => t.account_id === linkAcct && t.amount === -amt && Math.abs(dayDiff(t.date, dd)) <= 7 && !linked.has(t.id) && nameMatch(t.payee, b));
      if (!dup) tx.push({ id: 3e9 + tx.length, uid: `auto-${month}-${bid}`, account_id: linkAcct, date: dd, payee: billLabel(b).slice(0, 120), category: String(b.category || 'Bills').slice(0, 60), memo: 'From Bill Pay · autopay', amount: -amt, check_no: '', status: '', transfer_id: null, entered_by: 'Autopay', expected: 'autopay' });
    }
  }

  // ---------- local answers for reads ----------
  const userName = id => ((S.snap.users || []).find(u => u.id === id) || {}).display_name || null;
  function accountsOut() {
    const { tx } = derived();
    const sum = new Map(), clr = new Map(), cnt = new Map();
    for (const t of tx) {
      sum.set(t.account_id, (sum.get(t.account_id) || 0) + t.amount);
      cnt.set(t.account_id, (cnt.get(t.account_id) || 0) + 1);
      if (t.status === 'cleared' || t.status === 'reconciled') clr.set(t.account_id, (clr.get(t.account_id) || 0) + t.amount);
    }
    return S.snap.accounts.map(a => ({ ...a, balance: a.starting_balance + (sum.get(a.id) || 0), cleared_balance: a.starting_balance + (clr.get(a.id) || 0), tx_count: cnt.get(a.id) || 0 }))
      .sort((a, b) => a.archived - b.archived || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  const byDateDesc = (a, b) => b.date.localeCompare(a.date) || b.id - a.id;
  function transactionsOut(p) {
    const { tx, links } = derived();
    const account = p.get('account') ? Number(p.get('account')) : null;
    const q = (p.get('q') || '').toLowerCase(), from = p.get('from'), to = p.get('to'), status = p.get('status'), category = p.get('category');
    const lim = Math.min(Number(p.get('limit')) || 200, 5000), off = Number(p.get('offset')) || 0;
    const linked = new Set(links.filter(l => l.state === 'linked').map(l => l.tx_id));
    const accName = new Map(S.snap.accounts.map(a => [a.id, a.name]));
    let rows = tx.filter(t => (!account || t.account_id === account) && (!from || t.date >= from) && (!to || t.date <= to)
      && (!status || t.status === (status === 'open' ? '' : status)) && (!category || t.category === category)
      && (!q || [t.payee, t.memo, t.category, t.check_no].some(v => String(v || '').toLowerCase().includes(q))));
    rows.sort(byDateDesc);
    const all = rows;
    rows = rows.slice(off, off + lim).map(t => ({ ...t, created_by_name: userName(t.created_by), account_name: accName.get(t.account_id), bill_linked: (linked.has(t.id) || t.from_bill) ? 1 : null }));
    if (account && !q && !from && !to && !status && !category && rows.length) {
      const acct = S.snap.accounts.find(a => a.id === account);
      const olderIdx = off + rows.length; // everything after the page in date-desc order is older
      let running = acct.starting_balance + all.slice(olderIdx).reduce((s, t) => s + t.amount, 0);
      for (let i = rows.length - 1; i >= 0; i--) { running += rows[i].amount; rows[i].balance = running; }
    }
    return rows;
  }
  function suggestOut(p) {
    const { tx } = derived();
    const acct = Number(p.get('account')) || null;
    const pc = new Map(), pt = new Map(), cats = new Map();
    for (const t of tx) {
      if (t.payee) {
        const k = t.payee + '\u0000' + t.category; const e = pc.get(k) || { payee: t.payee, category: t.category, n: 0, last: 0 }; e.n++; e.last = Math.max(e.last, t.id); pc.set(k, e);
        pt.set(t.payee, (pt.get(t.payee) || 0) + 1);
      }
      if (t.category) cats.set(t.category, (cats.get(t.category) || 0) + 1);
    }
    const best = new Map();
    for (const e of pc.values()) {
      const b = best.get(e.payee);
      const better = !b || ((e.category === '') - (b.category === '') || b.n - e.n || b.last - e.last) < 0;
      if (better) best.set(e.payee, e);
    }
    const payees = [...best.values()].map(e => ({ payee: e.payee, category: e.category, n: pt.get(e.payee) })).sort((a, b) => b.n - a.n).slice(0, 400);
    let lastCheck = null;
    if (acct) for (const t of tx) if (t.account_id === acct && /^[0-9]/.test(t.check_no || '') && t.check_no.length <= 6) { const n = parseInt(t.check_no, 10); if (lastCheck == null || n > lastCheck) lastCheck = n; }
    return { payees, categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(x => x[0]), next_check: lastCheck ? lastCheck + 1 : null };
  }
  function summaryOut(p) {
    const { tx } = derived();
    const from = p.get('from'), to = p.get('to'), account = p.get('account') ? Number(p.get('account')) : null;
    const g = new Map();
    for (const t of tx) {
      if ((from && t.date < from) || (to && t.date > to) || (account && t.account_id !== account) || t.category === 'Transfer') continue;
      const e = g.get(t.category) || { category: t.category, spent: 0, received: 0, n: 0 };
      if (t.amount < 0) e.spent -= t.amount; else e.received += t.amount; e.n++; g.set(t.category, e);
    }
    return [...g.values()].sort((a, b) => b.spent - a.spent);
  }
  // paydays — same rules as the server
  function nextDate(p, t0) {
    if (p.every === 30) {
      const day = Number(p.anchor.slice(8, 10)); let [y, m] = t0.split('-').map(Number);
      for (let i = 0; i < 3; i++) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const d = `${y}-${pad(m)}-${pad(Math.min(day, last))}`; if (d > t0) return d; m++; if (m > 12) { m = 1; y++; } }
    }
    return p.anchor > t0 ? p.anchor : addDays(p.anchor, (Math.floor(dayDiff(t0, p.anchor) / p.every) + 1) * p.every);
  }
  function paydayList() {
    const L = S.snap.link; if (!L) return [];
    if (L.paydays && L.paydays.length) return L.paydays;
    return L.payday && L.payday.all ? L.payday.all.map(({ anchor, every, label, amount_cents }) => ({ anchor, every, label, amount_cents })) : [];
  }
  function paydayInfo() {
    const list = paydayList(); if (!list.length) return null;
    const t0 = today();
    const all = list.map(p => ({ ...p, date: nextDate(p, t0) })).sort((a, b) => a.date.localeCompare(b.date));
    const f = all[0];
    return { date: f.date, every: f.every, label: f.label, source: (S.snap.link.payday || {}).source || 'settings', anchor: f.anchor, all };
  }
  function paychecksOut() {
    const info = paydayInfo(); if (!info) return [];
    const t0 = today(), list = [], postHour = S.snap.post_hour == null ? 5 : S.snap.post_hour;
    const rows = new Map((S.snap.expected || []).map(r => [r.label + '|' + r.date, r]));
    for (const p of info.all) {
      let d = nextDate(p, t0); const stop = addDays(t0, 35); let n = 0;
      while (d <= stop && n < 6) {
        const row = rows.get(p.label + '|' + d);
        list.push({ label: p.label, date: d, amount_cents: row ? row.amount_cents : (p.amount_cents || 0), entered: !!row && !row.skipped, skipped: !!(row && row.skipped), posted: !!(row && row.posted_tx_id), default_cents: p.amount_cents || 0, posts_at: `${d} ${pad(postHour)}:00` });
        d = nextDate({ ...p, anchor: d }, d); n++;
      }
    }
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }
  function billsOut() {
    const { bills } = derived(); if (!bills) throw new Error('Bills are turned off');
    return { ...bills, cats: S.snap.bills.cats, link_account: S.snap.bills.link_account };
  }
  function upcomingOut(p) {
    const s = S.snap, f = s.features || {};
    const acct = Number(p.get('account')) || (s.link && s.link.account) || null;
    const a = accountsOut().find(x => x.id === acct);
    const out = { enabled: !!f.billpay, mode: f.billpay_mode, ok: false, error: null, items: [], total_cents: 0, balance_cents: a ? a.balance : 0, payday: acct ? paydayInfo() : null, link_account: s.link ? s.link.account : null, paychecks: acct ? paychecksOut() : [] };
    if (!f.billpay) return out;
    const { bills } = derived();
    if (!bills) { out.error = 'Bill Pay is not available offline'; return out; }
    out.ok = true;
    const t0 = today(), stop = out.payday ? out.payday.date : addDays(t0, 14), m0 = t0.slice(0, 7);
    for (const [bid, b] of Object.entries(bills.bills || {})) {
      const cents = Math.round(Number(b.amount_cents) || 0); if (!cents) continue;
      for (const m of [m0, monthAdd(m0, 1)]) {
        if (!billActive(b, m) || (bills.months[m] && bills.months[m][bid])) continue;
        const dd = dueDate(b, m); if (dd >= stop) continue;
        out.items.push({ bill_id: bid, month: m, name: billLabel(b), due: dd, amount_cents: cents, autopay: b.autopay === 'Yes', overdue: dd < t0, category: b.category || '' });
      }
    }
    out.items.sort((x, y) => x.due.localeCompare(y.due) || x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
    out.total_cents = out.items.reduce((s2, x) => s2 + x.amount_cents, 0);
    out.safe_cents = out.balance_cents - out.total_cents;
    return out;
  }
  function linkSettingsOut() { const L = S.snap.link; return L ? { ...L, payday: paydayInfo(), error: null } : { enabled: false }; }

  const READS = {
    '/status': () => { const s = S.snap, f = s.features || {}; return { needsSetup: false, user: s.user, version: s.version, rev: s.rev, billpay: !!f.billpay, billpay_mode: f.billpay_mode, bills: !!f.bills, offline: true }; },
    '/rev': () => ({ rev: S.snap.rev }),
    '/accounts': accountsOut,
    '/transactions': transactionsOut,
    '/suggest': suggestOut,
    '/summary': summaryOut,
    '/bills': billsOut,
    '/bills/upcoming': upcomingOut,
    '/paychecks': paychecksOut,
    '/link-settings': linkSettingsOut,
    '/features': () => ({ bills: !!S.snap.features.bills, external_billpay: S.snap.features.billpay_mode === 'external' }),
    '/users': () => S.snap.users
  };
  function localGet(path) {
    const [p, qs] = path.split('?');
    return READS[p](new URLSearchParams(qs || ''));
  }

  // ---------- offline writes (queued) ----------
  const WRITES = [
    ['POST', /^\/transactions$/], ['POST', /^\/transfers$/], ['PATCH', /^\/transactions\/\d+$/], ['DELETE', /^\/transactions\/\d+$/],
    ['POST', /^\/clear-all$/], ['POST', /^\/bills\/pay$/]
  ];
  const canQueue = (method, p) => WRITES.some(([m, re]) => m === method && re.test(p));
  const serverTx = uid => S.snap.transactions.find(t => t.uid === uid);
  const pick = (o, fields) => Object.fromEntries(fields.map(f => [f, o[f]]));
  const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const accountOk = id => S.snap.accounts.some(a => a.id === Number(id));

  function txFromBody(b) {
    if (!accountOk(b.account_id)) throw new Error('Pick an account');
    if (!validDate(b.date)) throw new Error('Date required');
    if (!Number.isInteger(b.amount_cents)) throw new Error('Amount required');
    return {
      uid: b.uid || rid(), account_id: Number(b.account_id), date: b.date, amount_cents: b.amount_cents,
      payee: String(b.payee || '').trim().slice(0, 200), category: String(b.category || '').trim().slice(0, 100), memo: String(b.memo || '').trim().slice(0, 1000),
      check_no: String(b.check_no || '').trim().slice(0, 30), status: ['cleared', 'reconciled'].includes(b.status) ? b.status : ''
    };
  }
  function changesFromBody(b) {
    const c = {};
    if (b.account_id !== undefined) { if (!accountOk(b.account_id)) throw new Error('Pick an account'); c.account_id = Number(b.account_id); }
    if (b.date !== undefined) { if (!validDate(b.date)) throw new Error('Date required'); c.date = b.date; }
    if (Number.isInteger(b.amount_cents)) c.amount = b.amount_cents;
    for (const [f, n] of [['payee', 200], ['category', 100], ['memo', 1000], ['check_no', 30]]) if (b[f] !== undefined) c[f] = String(b[f] || '').trim().slice(0, n);
    if (b.status !== undefined) c.status = ['cleared', 'reconciled'].includes(b.status) ? b.status : '';
    return c;
  }
  const findTx = id => derived().tx.find(t => t.id === Number(id));
  function guardEditable(t) {
    if (!t) throw new Error('That entry is gone');
    if (t.expected) throw new Error(t.expected === 'paycheck' ? 'This paycheck posts itself when the server is back. You can edit it then.' : 'This autopay payment is added when the server is back. You can edit it then.');
    if (t.from_bill) throw new Error('This payment came from marking a bill paid offline. Change it from the Bills tab, or after it syncs.');
  }

  // An op that is being sent right now is never changed; later edits become their own op that goes after it.
  function queuePatch(t, changes) {
    const createOp = S.outbox.find(o => !o.sending && o.type === 'tx.create' && o.tx.uid === t.uid);
    if (createOp) { // not on the server yet: just fold the edit into the pending add
      for (const [f, v] of Object.entries(changes)) { if (f === 'amount') createOp.tx.amount_cents = v; else createOp.tx[f] = v; }
      return;
    }
    if (S.outbox.some(o => !o.sending && o.type === 'transfer.create' && o.uids.includes(t.uid))) throw new Error('Edit this transfer after it syncs (or delete it and add it again).');
    let op = S.outbox.find(o => !o.sending && o.type === 'tx.update' && o.uid === t.uid);
    if (!op) { op = { type: 'tx.update', op_id: rid(), uid: t.uid, base: {}, changes: {}, payee: t.payee }; S.outbox.push(op); }
    // "base" is what this device believed the entry was before the edit; the server only applies a field that still matches it.
    for (const [f, v] of Object.entries(changes)) {
      if (!(f in op.base)) op.base[f] = t[f];
      if (op.base[f] === v) { delete op.changes[f]; delete op.base[f]; } else op.changes[f] = v;
    }
    if (!Object.keys(op.changes).length) S.outbox.splice(S.outbox.indexOf(op), 1);
  }

  async function queueWrite(method, path, body = {}) {
    const p = path.split('?')[0];
    const me = S.snap.user;
    if (method === 'POST' && p === '/transactions') {
      const tx = txFromBody(body);
      const op = { type: 'tx.create', op_id: rid(), local_id: nextLocalId(), tx };
      if (body.bill_link && body.bill_link.bill_id && tx.amount_cents < 0) op.bill_link = { bill_id: String(body.bill_link.bill_id), month: String(body.bill_link.month) };
      S.outbox.push(op); await saveOutbox();
      return { ...tx, id: op.local_id, amount: tx.amount_cents, entered_by: me.display_name, offline: true, linked: !!op.bill_link };
    }
    if (method === 'POST' && p === '/transfers') {
      const from = Number(body.from_account_id), to = Number(body.to_account_id);
      if (!accountOk(from) || !accountOk(to) || from === to) throw new Error('Pick two different accounts');
      if (!validDate(body.date)) throw new Error('Date required');
      const amt = Math.abs(Number(body.amount_cents) || 0); if (!amt) throw new Error('Amount required');
      const op = { type: 'transfer.create', op_id: rid(), transfer_id: body.transfer_id || rid().slice(0, 16), from_account_id: from, to_account_id: to, date: body.date, amount_cents: amt, memo: String(body.memo || '').trim(), uids: (body.uids && body.uids.length === 2) ? body.uids : [rid(), rid()], local_ids: [nextLocalId(), nextLocalId()] };
      S.outbox.push(op); await saveOutbox();
      return { ok: true, transfer_id: op.transfer_id, offline: true };
    }
    if (method === 'PATCH' && p.startsWith('/transactions/')) {
      const t = findTx(p.split('/')[2]); guardEditable(t);
      queuePatch(t, changesFromBody(body)); await saveOutbox();
      return { ...findTx(t.id), offline: true };
    }
    if (method === 'DELETE' && p.startsWith('/transactions/')) {
      const t = findTx(p.split('/')[2]); guardEditable(t);
      const createOp = S.outbox.find(o => !o.sending && ((o.type === 'tx.create' && o.tx.uid === t.uid) || (o.type === 'transfer.create' && o.uids.includes(t.uid))));
      if (createOp) {
        S.outbox.splice(S.outbox.indexOf(createOp), 1);
        if (createOp.type === 'tx.create') { const i = S.outbox.findIndex(o => !o.sending && o.type === 'tx.update' && o.uid === t.uid); if (i >= 0) S.outbox.splice(i, 1); }
      } else {
        const legs = t.transfer_id ? derived().tx.filter(x => x.transfer_id === t.transfer_id) : [t];
        // The delete is judged against the entry as it was before this device's own unsent edits.
        let base = pick(t, TX_FIELDS);
        for (const leg of legs) {
          const i = S.outbox.findIndex(o => !o.sending && o.type === 'tx.update' && o.uid === leg.uid);
          if (i >= 0) { const [u] = S.outbox.splice(i, 1); if (leg.uid === t.uid) base = { ...base, ...u.base }; }
        }
        S.outbox.push({ type: 'tx.delete', op_id: rid(), uid: t.uid, base, payee: t.payee });
      }
      await saveOutbox();
      return { ok: true, offline: true };
    }
    if (method === 'POST' && p === '/clear-all') {
      let n = 0;
      for (const id of body.ids || []) { const t = findTx(id); if (t && !t.status && !t.expected && !t.from_bill) { queuePatch(t, { status: 'cleared' }); n++; } }
      await saveOutbox();
      return { ok: true, count: n, offline: true };
    }
    if (method === 'POST' && p === '/bills/pay') {
      if (!S.snap.bills) throw new Error('Bills are turned off');
      const month = String(body.month || ''), bid = String(body.bill_id || '');
      if (!S.snap.bills.bills[bid] || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Bad month or bill');
      const sp = (S.snap.bills.months[month] || {})[bid];
      let base = { paid: !!sp, amount_cents: sp ? sp.amount_cents : null };
      const sending = S.outbox.filter(o => o.sending && o.type === 'bill.pay' && o.month === month && o.bill_id === bid).pop();
      if (sending) base = { paid: !!sending.payment, amount_cents: sending.payment ? sending.payment.amount_cents : null };
      const i = S.outbox.findIndex(o => !o.sending && o.type === 'bill.pay' && o.month === month && o.bill_id === bid);
      const prev = i >= 0 ? S.outbox.splice(i, 1)[0] : null;
      const want = body.payment == null ? null : { amount_cents: Math.max(0, Number.isInteger(body.payment.amount_cents) ? body.payment.amount_cents : Math.round(parseFloat(body.payment.amount) * 100) || 0), at: nowNaive() };
      const same = want ? (base.paid && base.amount_cents === want.amount_cents) : !base.paid;
      if (!same) S.outbox.push({ type: 'bill.pay', op_id: rid(), local_id: prev ? prev.local_id : nextLocalId(), month, bill_id: bid, payment: want, base, name: S.snap.bills.bills[bid].name });
      await saveOutbox();
      return { ok: true, offline: true, ...billsOut() };
    }
    throw new Error('Not available offline');
  }

  // ---------- sync ----------
  async function pull() {
    if (S.pulling) return S.pulling;
    S.pulling = (async () => {
      const r = await net('/sync/snapshot', {}, 45000);
      if (r.status === 401) { S.authLost = true; emit('auth'); throw new Error('Not signed in'); }
      if (!r.ok) throw new Error(`Sync failed (${r.status})`);
      const snap = await r.json();
      if (S.snap && S.snap.user && snap.user && S.snap.user.id !== snap.user.id && S.outbox.length) throw new Error('Signed in as someone else while changes are waiting');
      const changed = !S.snap || S.snap.rev !== snap.rev;
      S.snap = snap; S.lastSync = new Date().toISOString(); S.authLost = false; ver++;
      await store.set('snap', snap); await saveMeta();
      setOnline(true);
      emit('status'); if (changed) emit('change');
    })();
    try { return await S.pulling; } finally { S.pulling = null; }
  }

  async function flush() {
    if (S.flushing || !S.outbox.length || S.authLost) return;
    S.flushing = true; emit('status');
    try {
      while (S.outbox.length) {
        const batch = S.outbox.slice(0, 200);
        batch.forEach(o => { o.sending = true; });
        const send = batch.map(({ local_id, local_ids, payee, name, sending, ...rest }) => rest);
        let j;
        try {
          const r = await net('/sync/push', { method: 'POST', body: { ops: send } }, 45000);
          if (r.status === 401) { S.authLost = true; emit('auth'); return; }
          if (!r.ok) throw new Error(`Sync failed (${r.status})`);
          j = await r.json();
        } finally { batch.forEach(o => { delete o.sending; }); }
        const done = new Set();
        for (const res of j.results || []) {
          done.add(res.op_id);
          if (res.status !== 'ok' && res.message) addNote(res.message, res.status);
        }
        S.outbox = S.outbox.filter(o => !done.has(o.op_id));
        await saveOutbox();
        if (!done.size) break;
      }
      await pull();
      emit('change');
    } finally { S.flushing = false; emit('status'); }
  }
  function addNote(msg, kind) {
    S.notes.unshift({ at: new Date().toISOString(), msg, kind });
    S.notes = S.notes.slice(0, 30);
    store.set('notes', S.notes);
    emit('note', msg);
  }

  let tickT = null, kicking = false;
  async function tick() {
    if (kicking) return; kicking = true;
    try {
      if (!S.snap || !hasAuth()) return;
      const r = await net('/rev', {}, S.online === false ? 6000 : 8000);
      if (!r.ok) return;
      const j = await r.json();
      setOnline(true);
      if (S.outbox.length) await flush();
      else if (!S.snap || j.rev !== S.snap.rev) await pull();
    } catch (e) { if (e.offline) setOnline(false); }
    finally { kicking = false; }
  }
  const kick = () => { clearTimeout(tickT); tickT = setTimeout(tick, 50); };
  setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  window.addEventListener('online', kick);
  window.addEventListener('offline', () => setOnline(false));
  const hasAuth = () => NATIVE ? !!token() : true;

  // ---------- the app's api() ----------
  const LOCAL_READS = new Set(Object.keys(READS));
  const getCache = new Map();
  async function api(path, opts = {}) {
    await ready;
    const method = (opts.method || 'GET').toUpperCase();
    const p = path.split('?')[0];
    const useLocal = S.snap && (S.online === false || S.outbox.length > 0);
    // New entries get their permanent id here, so a save that times out but did reach the server is never added twice.
    if (method === 'POST' && p === '/transactions' && opts.body && !opts.body.uid) opts = { ...opts, body: { ...opts.body, uid: rid() } };
    if (method === 'POST' && p === '/transfers' && opts.body && !opts.body.transfer_id) opts = { ...opts, body: { ...opts.body, transfer_id: rid().slice(0, 16), uids: [rid(), rid()] } };
    if (useLocal && method === 'GET' && LOCAL_READS.has(p)) return localGet(path);
    if (useLocal && method !== 'GET' && canQueue(method, p)) { const r = await queueWrite(method, path, opts.body); kick(); return r; }
    // A screen may still hold the temporary number of an entry that has just synced.
    if (S.snap && /^\/transactions\/\d+$/.test(p) && Number(p.split('/')[2]) >= 1e9) {
      const t = (D && D.tx.find(x => x.id === Number(p.split('/')[2]))) || null;
      const st = t && serverTx(t.uid); if (st) path = `/transactions/${st.id}`;
    }
    try {
      const r = await net(path, opts, method === 'GET' ? (S.snap ? 6000 : 12000) : 15000);
      setOnline(true);
      let j = null; try { j = await r.json(); } catch {}
      if (!r.ok) { const e = new Error((j && j.error) || `Request failed (${r.status})`); e.status = r.status; throw e; }
      if (method === 'GET') getCache.set(path, j);
      else if (S.snap) setTimeout(() => pull().catch(() => {}), 300);
      return j;
    } catch (e) {
      if (!e.offline) throw e;
      setOnline(false);
      if (!S.snap) throw new Error("Can't reach the server, and this device doesn't have a saved copy yet. Connect once to download it.");
      if (method === 'GET') {
        if (LOCAL_READS.has(p)) return localGet(path);
        if (getCache.has(path)) return getCache.get(path);
        throw new Error("This part needs the server, which can't be reached right now. Your register and bills still work.");
      }
      if (canQueue(method, p)) { return await queueWrite(method, path, opts.body); }
      throw new Error("Can't reach the server, so this can't be changed right now. Entries, transfers, cleared marks and bill payments still work offline.");
    }
  }

  // ---------- sign in / out ----------
  async function login(username, password, server) {
    if (NATIVE) {
      if (server !== undefined) LS.set('cb.server', String(server).trim().replace(/\/+$/, ''));
      LS.del('cb.token');
    }
    const body = { username, password, ...(NATIVE ? { app: true, device: `${NATIVE.platform === 'android' ? 'Android' : 'Windows'} app` } : {}) };
    let r;
    try { r = await net('/login', { method: 'POST', body }, 15000); }
    catch (e) { throw new Error(NATIVE ? `Can't reach ${serverBase() || 'the server'}. Check the address and that Tailscale is connected.` : e.message); }
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || `Sign-in failed (${r.status})`);
    if (S.snap && S.snap.user && S.snap.user.id !== j.user.id) {
      if (S.outbox.length) { if (NATIVE) LS.del('cb.token'); throw new Error(`This device has ${S.outbox.length} change(s) from ${S.snap.user.display_name} that haven't synced. Sign in as ${S.snap.user.display_name} first so they're sent.`); }
      await wipe();
    }
    if (NATIVE && j.token) LS.set('cb.token', j.token);
    S.authLost = false; setOnline(true);
    try { await pull(); if (S.outbox.length) await flush(); } catch (e) { console.warn('first sync', e); }
    return j;
  }
  async function wipe() {
    S.snap = null; S.outbox = []; S.notes = []; S.lastSync = null; ver++;
    await store.clear();
    emit('status');
  }
  async function logout() {
    try { await net('/logout', { method: 'POST', body: {} }, 6000); } catch {}
    if (NATIVE) LS.del('cb.token');
    await wipe();
  }

  // Downloads (CSV export, database backup). The installed apps can't use a plain link because they sign in with a token.
  async function download(path, filename) {
    const r = await net(path, {}, 60000);
    if (!r.ok) { let j = null; try { j = await r.json(); } catch {} throw new Error((j && j.error) || `Download failed (${r.status})`); }
    const blob = await r.blob();
    if (window.CBAndroid && window.CBAndroid.saveFile) {
      const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      window.CBAndroid.saveFile(filename, btoa(bin), blob.type || 'application/octet-stream');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function status() {
    return {
      online: S.online, lastSync: S.lastSync, pending: S.outbox.length, flushing: S.flushing, notes: S.notes, hasCopy: !!S.snap, authLost: S.authLost,
      entries: S.snap ? S.snap.transactions.length : 0, serverVersion: S.snap ? S.snap.version : null,
      pendingList: S.outbox.map(o => o.type === 'tx.create' ? `Add ${o.tx.payee || 'entry'} ${(o.tx.amount_cents / 100).toFixed(2)}` : o.type === 'transfer.create' ? `Transfer ${(o.amount_cents / 100).toFixed(2)}` : o.type === 'tx.update' ? `Change ${o.payee || 'entry'}` : o.type === 'tx.delete' ? `Delete ${o.payee || 'entry'}` : o.type === 'bill.pay' ? `${o.payment ? 'Pay' : 'Unmark'} ${o.name || 'bill'}` : o.type)
    };
  }

  window.CBSync = {
    ready, api, login, logout, wipe, download, status, on, kick, pull: () => pull(), flush: () => flush(),
    native: NATIVE, server: serverBase, setServer: v => LS.set('cb.server', String(v).trim().replace(/\/+$/, '')),
    hasToken: () => !!token(), clearNotes: () => { S.notes = []; store.set('notes', []); emit('status'); },
    canQueue
  };
})();

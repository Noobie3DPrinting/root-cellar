/* Checkbook PWA front end — plain JS, no build step. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
    return n;
  };
  // "kroger market" -> "Kroger Market"; leaves ALL-CAPS words (NIPSCO, AT&T) and mid-word caps (McDonald's, iTunes) alone
  const titleCase = str => String(str || '').replace(/\S+/g, w => (w === w.toUpperCase() && /[A-Z]/.test(w)) ? w : (/^[a-z]/.test(w) && !/[A-Z]/.test(w.slice(1))) ? w[0].toUpperCase() + w.slice(1) : (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w));
  const autoCap = input => { input.addEventListener('change', () => { input.value = titleCase(input.value); }); return input; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const niceDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: y === new Date().getFullYear() ? undefined : 'numeric' }); };
  const toast = (msg, ms = 2200) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); };

  // All server calls go through the offline engine (sync.js): it answers from this device's copy when the server can't be reached.
  const Sync = window.CBSync;
  const NATIVE = Sync.native;
  async function api(path, opts = {}) {
    try { return await Sync.api(path, opts); }
    catch (e) { if (e.status === 401 && state.user) { state.user = null; route('login'); } throw e; }
  }

  const applyTheme = t => {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const acc = getComputedStyle(root).getPropertyValue('--accent').trim() || '#1f6f5f';
    document.querySelectorAll('meta[name=theme-color]').forEach(m => m.content = dark ? '#182220' : acc);
  };
  const ACCENTS = [['forest', 'Forest', '#1f6f5f'], ['ocean', 'Ocean', '#1f5f8f'], ['plum', 'Plum', '#6b3d8f'], ['ember', 'Ember', '#b24a1b'], ['rose', 'Rose', '#a8325a'], ['slate', 'Slate', '#3b4a5a']];
  const applyAccent = a => { const root = document.documentElement; if (!a || a === 'forest') root.removeAttribute('data-accent'); else root.setAttribute('data-accent', a); applyTheme(localStorage.getItem('cb.theme') || 'system'); };
  applyAccent(localStorage.getItem('cb.accent'));
  applyTheme(localStorage.getItem('cb.theme') || 'system');
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(localStorage.getItem('cb.theme') || 'system'));

  const state = { offline: false, user: null, accounts: [], accountId: Number(localStorage.getItem('cb.account')) || null, view: 'accounts', suggest: { payees: [], categories: [] }, rev: null, billpay: false, up: null };
  const view = $('#view'), topbar = $('#topbar'), nav = $('#nav');

  function setTop(title, sub, right) {
    topbar.replaceChildren(el('h1', {}, title, sub ? el('span', { class: 'sub' }, sub) : null), ...(right || []));
    renderSyncBar();
  }
  // ---------------- offline / sync status ----------------
  const when = iso => { if (!iso) return 'never'; const d = new Date(iso), t = new Date(); const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); return d.toDateString() === t.toDateString() ? 'today ' + time : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + time; };
  function renderSyncBar() {
    const bar = $('#syncbar'); if (!bar) return;
    const st = Sync.status();
    if (!state.user || !st.hasCopy) { bar.hidden = true; return; }
    const waiting = st.pending ? ` · ${st.pending} change${st.pending === 1 ? '' : 's'} waiting to sync` : '';
    if (st.online === false) {
      bar.hidden = false; bar.className = 'syncbar off';
      bar.replaceChildren(el('span', { class: 'grow' }, el('b', {}, 'Offline'), ` — showing your copy from ${when(st.lastSync)}${waiting}`), el('button', { class: 'linkbtn', onclick: () => { toast('Trying the server…'); Sync.kick(); } }, 'Retry'));
    } else if (st.pending || st.flushing) {
      bar.hidden = false; bar.className = 'syncbar busy';
      bar.replaceChildren(`Syncing${waiting || '…'}`);
    } else if (st.authLost) {
      bar.hidden = false; bar.className = 'syncbar off'; bar.replaceChildren('Sign in again to keep syncing');
    } else bar.hidden = true;
  }
  const sheetOpen = () => $('#sheet-root').children.length > 0;
  let rerenderWanted = false;
  const rerender = () => { if (!state.user || ['login', 'setup', 'import'].includes(state.view)) return; if (sheetOpen()) { rerenderWanted = true; return; } rerenderWanted = false; route(state.view); };
  Sync.on('status', () => {
    const st = Sync.status(), was = state.offline;
    state.offline = st.online === false;
    renderSyncBar();
    if (was !== state.offline && state.user) rerender();
  });
  Sync.on('offline', () => { if (state.user) toast("Can't reach the server — working from this device's copy", 3500); });
  Sync.on('online', () => { if (state.user) toast('Server is back — syncing', 2500); });
  Sync.on('change', () => { if (!Sync.status().flushing) rerender(); });
  Sync.on('note', msg => { toast(msg, 7000); });
  Sync.on('auth', () => { if (state.user) { state.user = null; route('login'); toast('Please sign in again so your changes can sync', 5000); } });
  setInterval(() => { if (rerenderWanted && !sheetOpen()) rerender(); }, 1500);
  function setNav(active) {
    nav.hidden = !state.user;
    const slot = nav.querySelector('[data-nav=reports],[data-nav=bills]');
    if (slot) { const bills = !!state.bills; slot.dataset.nav = bills ? 'bills' : 'reports'; slot.setAttribute('aria-label', bills ? 'Bills' : 'Reports'); slot.innerHTML = bills ? '<span class="ic">☷</span><span>Bills</span>' : '<span class="ic">◔</span><span>Reports</span>'; }
    view.classList.toggle('noNav', !state.user);
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.nav === active));
  }
  nav.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.nav === 'add') openTxSheet(); else route(b.dataset.nav);
  });

  async function loadAccounts() { state.accounts = await api('/accounts'); if (!state.accountId || !state.accounts.find(a => a.id === state.accountId)) state.accountId = (state.accounts.find(a => !a.archived) || state.accounts[0] || {}).id || null; }
  const curAccount = () => state.accounts.find(a => a.id === state.accountId);

  // shared with bills.js
  window.CB = { $, el, fmt, api, state, route: (...a) => route(...a), setTop, setNav, openSheet: (...a) => openSheet(...a), toast, titleCase, autoCap, autocompleteWrap: (...a) => autocompleteWrap(...a), views: {} };

  // ---------------- routing ----------------
  async function route(v, arg) {
    state.view = v;
    view.replaceChildren(el('div', { class: 'loading' }, 'Loading…'));
    try {
      if (!state.user && !['login', 'setup'].includes(v)) v = 'login';
      const views = { login: viewLogin, setup: viewSetup, accounts: viewAccounts, register: viewRegister, reports: viewReports, settings: viewSettings, import: viewImport, ...window.CB.views };
      if (v === 'bills' && !state.bills) v = 'accounts';
      await views[v](arg);
    } catch (e) { view.replaceChildren(el('div', { class: 'empty' }, e.message)); }
  }

  // ---------------- auth ----------------
  function authForm(kind) {
    const isSetup = kind === 'setup';
    const serverIn = NATIVE ? el('input', { class: 'input', type: 'url', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', placeholder: 'Server address', value: Sync.server() }) : null;
    const user = el('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Username', required: true });
    const name = el('input', { class: 'input', placeholder: 'Display name (e.g. Chris)', autocomplete: 'name' });
    const pass = el('input', { class: 'input', type: 'password', autocomplete: isSetup ? 'new-password' : 'current-password', placeholder: isSetup ? 'Password (8+ characters)' : 'Password', required: true });
    const err = el('div', { class: 'err' });
    const form = el('form', { class: 'auth stack', onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = isSetup ? await api('/setup', { method: 'POST', body: { username: user.value, display_name: name.value, password: pass.value } })
          : await Sync.login(user.value, pass.value, serverIn ? serverIn.value : undefined);
        state.user = r.user; const st = await api('/status'); state.version = st.version; state.billpay = !!st.billpay; state.bills = !!st.bills; await loadAccounts(); route(state.accounts.length ? 'register' : 'accounts');
      } catch (ex) { err.textContent = ex.message; }
    } },
      el('div', { class: 'logo' }, '🧾'),
      el('h1', {}, isSetup ? 'Set up your Checkbook' : 'Checkbook'),
      isSetup ? el('p', { class: 'muted center small' }, 'Create the first account. It will be the admin, and can add other users later.') : null,
      serverIn ? el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Server (your Checkbook address on Tailscale)'), serverIn) : null,
      user, isSetup ? name : null, pass, err,
      el('button', { class: 'btn primary block', type: 'submit' }, isSetup ? 'Create admin account' : 'Sign in'));
    return form;
  }
  async function viewLogin() { setTop('Checkbook'); setNav(); view.replaceChildren(authForm('login')); }
  async function viewSetup() { setTop('Welcome'); setNav(); view.replaceChildren(authForm('setup')); }

  // ---------------- accounts ----------------
  async function viewAccounts() {
    await loadAccounts();
    setTop('Accounts', state.user.display_name, [state.bills ? el('button', { class: 'icon', 'aria-label': 'Reports', title: 'Reports', onclick: () => route('reports') }, '◔') : null, el('button', { class: 'icon', 'aria-label': 'Add account', onclick: () => openAccountSheet() }, '+')]);
    setNav('accounts');
    const active = state.accounts.filter(a => !a.archived), archived = state.accounts.filter(a => a.archived);
    const total = active.reduce((s, a) => s + a.balance, 0);
    const list = el('div');
    if (!state.accounts.length) list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🏦'), el('div', {}, 'No accounts yet.'), el('div', { class: 'small', style: 'margin-top:14px' }, el('button', { class: 'btn primary', onclick: () => openAccountSheet() }, 'Add an account'), ' ', el('button', { class: 'btn', onclick: () => route('import') }, 'Import from another app'))));
    else {
      list.append(el('div', { class: 'total' }, el('span', {}, 'Total'), el('b', { class: total < 0 ? 'neg' : '' }, fmt(total))));
      for (const a of active) list.append(accountRow(a));
      if (archived.length) { list.append(el('div', { class: 'daygroup' }, 'Archived')); for (const a of archived) list.append(accountRow(a)); }
    }
    view.replaceChildren(list);
  }
  function accountRow(a) {
    return el('button', { class: 'acct', onclick: () => { state.accountId = a.id; localStorage.setItem('cb.account', a.id); route('register'); } },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, a.name), el('div', { class: 'meta' }, titleCase(a.type))),
      el('div', { class: 'bal ' + (a.balance < 0 ? 'neg' : '') }, fmt(a.balance)));
  }
  function openAccountSheet(a) {
    const name = el('input', { class: 'input', placeholder: 'e.g. Chase Checking', value: a ? a.name : '' });
    const type = el('select', { class: 'input' }, ...['checking', 'savings', 'credit card', 'cash', 'other'].map(t => el('option', { value: t, selected: a && a.type === t }, titleCase(t))));
    const sb = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: '0.00', value: a ? (a.starting_balance / 100).toFixed(2) : '' });
    const err = el('div', { class: 'err' });
    const sheet = openSheet(a ? 'Edit account' : 'New account',
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Type'), type), el('label', { class: 'field' }, el('span', {}, 'Starting balance'), sb)),
      err,
      el('div', { class: 'btnrow' },
        a ? el('button', { class: 'btn', onclick: async () => { await api(`/accounts/${a.id}`, { method: 'PATCH', body: { archived: !a.archived } }); sheet.close(); route('accounts'); } }, a.archived ? 'Unarchive' : 'Archive') : null,
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            const body = { name: name.value, type: type.value, starting_balance: Math.round(parseFloat(sb.value || '0') * 100) };
            if (a) await api(`/accounts/${a.id}`, { method: 'PATCH', body }); else { const r = await api('/accounts', { method: 'POST', body }); state.accountId = r.id; }
            sheet.close(); route(a ? 'register' : 'accounts');
          } catch (ex) { err.textContent = ex.message; }
        } }, 'Save')));
    setTimeout(() => name.focus(), 50);
  }

  // ---------------- register ----------------
  let regFilter = { q: '', status: '' };
  async function viewRegister() {
    await loadAccounts();
    const a = curAccount();
    if (!a) { setTop('Register'); setNav('register'); view.replaceChildren(el('div', { class: 'empty' }, 'Add an account first.')); return; }
    setTop(a.name, titleCase(a.type), [
      el('button', { class: 'icon', 'aria-label': 'Edit account', onclick: () => openAccountSheet(a) }, '✎'),
      el('button', { class: 'icon', 'aria-label': 'Switch account', onclick: () => switchAccount() }, '⇅')]);
    setNav('register');
    const q = el('input', { class: 'input grow', type: 'search', placeholder: 'Search payee, memo, category, check #', value: regFilter.q, oninput: debounce(() => { regFilter.q = q.value; loadList(); }, 250) });
    const st = el('select', { class: 'input', style: 'width:auto', onchange: () => { regFilter.status = st.value; loadList(); } },
      el('option', { value: '' }, 'All'), el('option', { value: 'open', selected: regFilter.status === 'open' }, 'Uncleared'), el('option', { value: 'cleared', selected: regFilter.status === 'cleared' }, 'Cleared'), el('option', { value: 'reconciled', selected: regFilter.status === 'reconciled' }, 'Reconciled'));
    const list = el('div');
    const balStrip = el('div', { class: 'balances' },
      el('div', { class: 'b main' }, el('span', {}, 'Available'), el('b', { class: a.balance < 0 ? 'neg' : '' }, fmt(a.balance))),
      el('div', { class: 'b' }, el('span', {}, 'Cleared'), el('b', { class: a.cleared_balance < 0 ? 'neg' : '' }, fmt(a.cleared_balance))),
      el('div', { class: 'b' }, el('span', {}, 'Pending'), el('b', { class: 'warnc' }, fmt(a.balance - a.cleared_balance))));
    const billsRow = el('button', { class: 'billsrow', hidden: true, onclick: () => openBillsSheet() });
    const tools = el('div', { class: 'row small', style: 'margin:-4px 0 10px' },
      el('button', { class: 'btn small', onclick: () => openReconcile(a) }, 'Reconcile'),
      state.billpay ? el('button', { class: 'btn small', onclick: () => openBillsSheet() }, 'Upcoming') : null,
      state.bills ? el('button', { class: 'btn small', onclick: () => route('bills') }, 'All bills') : null);
    view.replaceChildren(balStrip, el('div', { class: 'filters' }, q, st), billsRow, tools, list);
    loadUpcoming(billsRow);
    async function loadList() {
      const p = new URLSearchParams({ account: a.id, limit: 500 });
      if (regFilter.q) p.set('q', regFilter.q); if (regFilter.status) p.set('status', regFilter.status);
      const rows = await api('/transactions?' + p);
      list.replaceChildren();
      if (!rows.length) { list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📭'), regFilter.q || regFilter.status ? 'Nothing matches.' : 'No transactions yet. Tap + to add one.')); return; }
      let lastDate = null;
      for (const t of rows) {
        if (t.date !== lastDate) { list.append(el('div', { class: 'daygroup' }, niceDate(t.date))); lastDate = t.date; }
        list.append(txRow(t));
      }
    }
    loadList();
  }
  function txRow(t) {
    const st = el('button', { class: 'st ' + t.status, title: 'Tap to cycle cleared / reconciled', onclick: async e => {
      e.stopPropagation();
      if (t.expected || t.from_bill) return toast(t.expected ? 'This is added by the server when it is back' : 'This syncs from Bills first');
      const next = t.status === '' ? 'cleared' : t.status === 'cleared' ? 'reconciled' : '';
      await api(`/transactions/${t.id}`, { method: 'PATCH', body: { status: next } });
      t.status = next; st.className = 'st ' + next; st.textContent = next === 'cleared' ? '✓' : next === 'reconciled' ? 'R' : ''; st.closest('.tx').className = 'tx ' + (next || 'pending');
      loadAccounts().then(() => { const a = curAccount(); if (a && state.view === 'register') updateBalances(a); });
    } }, t.status === 'cleared' ? '✓' : t.status === 'reconciled' ? 'R' : '');
    const sub = [t.check_no ? '#' + t.check_no : null, t.category || null, t.memo || null].filter(Boolean).join(' · ');
    const row = el('div', { class: 'tx ' + (t.status || 'pending') + (t.expected ? ' expected' : ''), role: 'button', tabindex: 0, onclick: () => t.expected ? toast(t.expected === 'paycheck' ? 'Your paycheck counts from 5 AM on payday. It posts for real when the server is back.' : 'Autopay bill due today. It posts for real when the server is back.', 4500) : openTxSheet(t), onkeydown: e => { if (e.key === 'Enter') openTxSheet(t); } },
      st,
      el('div', { style: 'min-width:0' }, el('div', { class: 'payee' }, t.payee || '(no payee)'), el('div', { class: 'sub' }, t.expected ? el('span', { class: 'tag exp' }, t.expected === 'paycheck' ? 'Expected · posts at 5 AM payday' : 'Expected · autopay') : null, t.pending ? el('span', { class: 'tag pend' }, 'Not synced yet') : null, [sub, t.bill_linked ? 'Bill Pay ✓' : null, t.entered_by ? 'by ' + t.entered_by : null].filter(Boolean).join(' · '))),
      el('div', {}, el('div', { class: 'amt ' + (t.amount < 0 ? 'neg' : 'pos') }, fmt(t.amount)), t.balance != null ? el('div', { class: 'runbal' }, fmt(t.balance)) : null));
    return row;
  }
  function updateBalances(a) {
    const bs = $('.balances'); if (!bs) return;
    const vals = [a.balance, a.cleared_balance, a.balance - a.cleared_balance];
    bs.querySelectorAll('b').forEach((b, i) => { b.textContent = fmt(vals[i]); if (i < 2) b.className = vals[i] < 0 ? 'neg' : ''; });
  }
  function switchAccount() {
    const sheet = openSheet('Switch account', ...state.accounts.filter(a => !a.archived).map(a => el('button', { class: 'acct', onclick: () => { state.accountId = a.id; localStorage.setItem('cb.account', a.id); sheet.close(); route('register'); } },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, a.name)), el('div', { class: 'bal' }, fmt(a.balance)))));
  }

  // ---------------- transaction sheet ----------------
  async function openTxSheet(t, prefill) {
    if (!state.accounts.length) await loadAccounts();
    if (!state.accounts.length) return toast('Add an account first');
    const sugg = api('/suggest?account=' + (t ? t.account_id : state.accountId)).then(s => state.suggest = s).catch(() => ({}));
    const bill = prefill && prefill.bill;
    const isEdit = !!t, isTransfer = !!(t && t.transfer_id);
    let sign = t ? (t.amount >= 0 ? 1 : -1) : -1;
    let mode = 'tx';
    const acct = el('select', { class: 'input' }, ...state.accounts.filter(a => !a.archived || (t && a.id === t.account_id)).map(a => el('option', { value: a.id, selected: (t ? t.account_id : state.accountId) === a.id }, a.name)));
    const toAcct = el('select', { class: 'input' }, ...state.accounts.filter(a => !a.archived).map(a => el('option', { value: a.id }, a.name)));
    const date = el('input', { class: 'input', type: 'date', value: t ? t.date : today(), required: true });
    const amount = el('input', { class: 'input amount-input', inputmode: 'decimal', placeholder: '0.00', value: t ? (Math.abs(t.amount) / 100).toFixed(2) : bill ? (bill.amount_cents / 100).toFixed(2) : '', autocomplete: 'off' });
    const payee = autoCap(el('input', { class: 'input', placeholder: 'Payee', value: t ? t.payee : bill ? bill.name : '', autocomplete: 'off', autocapitalize: 'words' }));
    const category = autoCap(el('input', { class: 'input', placeholder: 'Category', value: t ? t.category : bill ? (bill.category || 'Bills') : '', autocomplete: 'off', autocapitalize: 'words' }));
    const memo = el('input', { class: 'input', placeholder: 'Memo (optional)', value: t ? t.memo : '', autocomplete: 'off' });
    const check = el('input', { class: 'input', inputmode: 'numeric', placeholder: 'Check #', value: t ? t.check_no : '', autocomplete: 'off' });
    const nextBtn = el('button', { type: 'button', class: 'btn small', title: 'Next check number', onclick: () => { if (state.suggest.next_check) check.value = state.suggest.next_check; else toast('No check numbers yet'); } }, 'Next');
    const status = el('select', { class: 'input' }, el('option', { value: '' }, 'Uncleared'), el('option', { value: 'cleared', selected: t && t.status === 'cleared' }, 'Cleared'), el('option', { value: 'reconciled', selected: t && t.status === 'reconciled' }, 'Reconciled'));
    const err = el('div', { class: 'err' });
    const segBtn = (label, s) => el('button', { type: 'button', onclick: () => { sign = s; refreshSeg(); } }, label);
    const segOut = segBtn('Withdrawal', -1), segIn = segBtn('Deposit', 1), segXfer = el('button', { type: 'button', onclick: () => { mode = 'xfer'; refreshSeg(); } }, 'Transfer');
    const seg = el('div', { class: 'seg' }, segOut, segIn, isEdit ? null : segXfer);
    const txFields = el('div', {},
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Account'), acct), el('label', { class: 'field' }, el('span', {}, 'Date'), date)),
      el('label', { class: 'field' }, el('span', {}, 'Payee'), autocompleteWrap(payee, () => state.suggest.payees.map(p => ({ v: p.payee, sub: p.category, extra: p })), p => {
        // Picking a payee brings its usual category along; amount and date are left for you
        if (p.extra && p.extra.category && !category.value.trim()) category.value = p.extra.category;
      })),
      el('label', { class: 'field' }, el('span', {}, 'Category'), autocompleteWrap(category, () => state.suggest.categories.map(c => ({ v: c })))),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Check #'), el('div', { class: 'row', style: 'gap:6px' }, check, nextBtn)), el('label', { class: 'field' }, el('span', {}, 'Status'), status)),
      el('label', { class: 'field' }, el('span', {}, 'Memo'), memo));
    const xferFields = el('div', { hidden: true },
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'From'), acct), el('label', { class: 'field' }, el('span', {}, 'To'), toAcct)),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Date'), date), el('label', { class: 'field' }, el('span', {}, 'Memo'), memo)));
    function refreshSeg() {
      segOut.className = mode === 'tx' && sign < 0 ? 'on neg' : ''; segIn.className = mode === 'tx' && sign > 0 ? 'on pos' : ''; segXfer.className = mode === 'xfer' ? 'on' : '';
      if (mode === 'xfer') { txFields.hidden = true; xferFields.hidden = false; xferFields.querySelector('.grid2 label').append(acct); xferFields.querySelectorAll('.grid2')[1].firstChild.append(date); xferFields.querySelectorAll('.grid2')[1].lastChild.append(memo); }
      else { xferFields.hidden = true; txFields.hidden = false; txFields.querySelector('.grid2 label').append(acct); txFields.querySelectorAll('.grid2')[0].lastChild.append(date); txFields.lastChild.append(memo); }
      amount.classList.toggle('neg', mode === 'tx' && sign < 0); amount.classList.toggle('pos', mode === 'tx' && sign > 0);
    }
    segOut.onclick = () => { mode = 'tx'; sign = -1; refreshSeg(); }; segIn.onclick = () => { mode = 'tx'; sign = 1; refreshSeg(); };
    refreshSeg();
    const sheet = openSheet(isEdit ? (isTransfer ? 'Edit transfer leg' : 'Edit transaction') : 'Add transaction',
      isTransfer ? el('p', { class: 'muted small' }, 'This is one side of a transfer. Deleting it removes both sides.') : seg,
      el('label', { class: 'field' }, el('span', {}, 'Amount'), amount),
      txFields, xferFields, err,
      el('div', { class: 'btnrow' },
        isEdit ? el('button', { class: 'btn danger', onclick: async () => { if (!confirm('Delete this transaction?')) return; await api(`/transactions/${t.id}`, { method: 'DELETE' }); sheet.close(); toast('Deleted'); route(state.view); } }, 'Delete') : null,
        el('button', { class: 'btn primary', onclick: save }, isEdit ? 'Save' : 'Add')));
    async function save() {
      err.textContent = '';
      const amt = Math.round(parseFloat(String(amount.value).replace(/[^0-9.\-]/g, '')) * 100);
      if (!amt) { err.textContent = 'Enter an amount'; amount.focus(); return; }
      try {
        if (mode === 'xfer') {
          await api('/transfers', { method: 'POST', body: { from_account_id: Number(acct.value), to_account_id: Number(toAcct.value), date: date.value, amount_cents: Math.abs(amt), memo: memo.value } });
        } else {
          const body = { account_id: Number(acct.value), date: date.value, amount_cents: Math.abs(amt) * sign, payee: titleCase(payee.value), category: titleCase(category.value), memo: memo.value, check_no: check.value, status: status.value };
          if (bill && sign < 0) body.bill_link = { bill_id: bill.bill_id, month: bill.month };
          if (isEdit) await api(`/transactions/${t.id}`, { method: 'PATCH', body });
          else {
            const r = await api('/transactions', { method: 'POST', body });
            if (r.offline) toast('Saved on this device · syncs when the server is back', 3000);
            else if (r.warning) toast(r.warning, 4000);
            else if (r.linked) toast('Added · marked paid in Bill Pay', 3000);
            else if (r.bill_match) setTimeout(() => openMatch(r.id, r.bill_match), 250);
            else toast('Added');
          }
        }
        sheet.close(); if (isEdit || mode === 'xfer') toast((isEdit ? 'Saved' : 'Transfer added') + (state.offline ? ' on this device · will sync' : ''));
        if (!isEdit && mode !== 'xfer') { state.accountId = Number(acct.value); localStorage.setItem('cb.account', state.accountId); }
        route(state.view === 'login' ? 'register' : state.view);
      } catch (ex) { err.textContent = ex.message; }
    }
    setTimeout(() => (isEdit ? payee : amount).focus(), 80);
  }

  // ---------------- Bill Pay UI ----------------
  const shortDay = iso => new Date(iso + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  async function loadUpcoming(rowEl) {
    if (!state.billpay) return;
    try { state.up = await api('/bills/upcoming?account=' + state.accountId); } catch { state.up = null; }
    if (rowEl && rowEl.isConnected) renderBillsRow(rowEl);
  }
  function renderBillsRow(rowEl) {
    const u = state.up;
    if (!u || !u.enabled || (u.ok && u.link_account !== state.accountId)) { rowEl.hidden = true; return; }
    rowEl.hidden = false;
    if (!u.ok) { rowEl.replaceChildren(state.offline ? 'Bills are not in this device\'s copy yet' : "Bill Pay isn't answering right now"); return; }
    const when = u.payday ? `before ${u.payday.label && u.payday.all && u.payday.all.length > 1 ? u.payday.label + '\'s payday' : 'payday'} ${shortDay(u.payday.date)}` : 'in the next 2 weeks';
    rowEl.replaceChildren(el('div', {}, `${u.items.length} unpaid bill${u.items.length === 1 ? '' : 's'} ${when}: `, el('b', {}, fmt(u.total_cents))),
      el('div', {}, 'Safe to spend: ', el('b', { class: u.safe_cents < 0 ? 'neg' : 'pos' }, fmt(u.safe_cents))));
  }
  function paychecksCard(list) {
    if (!list || !list.length) return null;
    const rows = list.slice(0, 4).map(pc => {
      const inp = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: pc.default_cents ? (pc.default_cents / 100).toFixed(2) : 'Amount', value: pc.entered ? (pc.amount_cents / 100).toFixed(2) : '', disabled: pc.posted, style: 'min-height:40px;padding:8px 10px;width:110px;text-align:right' });
      const save = el('button', { class: 'btn small primary', hidden: true, onclick: async () => {
        const c = Math.round(parseFloat(String(inp.value).replace(/[^0-9.]/g, '')) * 100);
        try { await api('/paychecks', { method: 'PUT', body: c ? { label: pc.label, date: pc.date, amount_cents: c } : { label: pc.label, date: pc.date, skip: true } }); toast(c ? `Saved · posts ${shortDay(pc.date)} at 5 AM` : 'Cleared', 3000); openBillsSheetRefresh(); }
        catch (e) { toast(e.message, 4000); }
      } }, 'Save');
      inp.oninput = () => { save.hidden = false; };
      inp.onkeydown = e => { if (e.key === 'Enter') save.click(); };
      const status = pc.posted ? 'posted to register' : pc.entered ? `will post ${shortDay(pc.date)} 5:00 AM` : pc.default_cents ? `usual ${fmt(pc.default_cents)} · will post ${shortDay(pc.date)} 5:00 AM` : 'enter the amount when you know it';
      return el('div', { class: 'row', style: 'padding:8px 0;border-top:1px solid var(--line)' },
        el('div', { class: 'grow', style: 'min-width:0' }, el('div', {}, el('b', {}, pc.label), ' · ', shortDay(pc.date)), el('div', { class: 'muted small' }, status)),
        inp, save);
    });
    return el('div', { class: 'card' }, el('h2', {}, 'Paychecks'),
      el('div', { class: 'muted small', style: 'margin-bottom:6px' }, 'Not counted as available until 5:00 AM on the payday, when it posts itself as a deposit.'),
      ...rows);
  }
  let openBillsSheetRefresh = () => {};
  async function openBillsSheet() {
    await loadUpcoming();
    const u = state.up; if (!u) return toast("Can't reach Bill Pay");
    const sheet = openSheet(u.payday ? 'Bills before payday' : 'Bills in the next 2 weeks',
      el('div', { class: 'card' },
        u.payday ? el('div', { class: 'row' }, el('span', { class: 'grow muted' }, 'Next payday' + (u.payday.all && u.payday.all.length > 1 ? ` (${u.payday.label})` : '')), el('b', {}, shortDay(u.payday.date))) : null,
        el('div', { class: 'row' }, el('span', { class: 'grow muted' }, 'Balance now'), el('b', { class: 'mono' }, fmt(u.balance_cents))),
        el('div', { class: 'row' }, el('span', { class: 'grow muted' }, 'Unpaid bills before then'), el('b', { class: 'mono' }, '−' + fmt(u.total_cents))),
        el('div', { class: 'row', style: 'font-size:18px;margin-top:6px' }, el('span', { class: 'grow' }, 'Safe to spend'), el('b', { class: 'mono ' + (u.safe_cents < 0 ? 'neg' : 'pos') }, fmt(u.safe_cents)))),
      paychecksCard(u.paychecks),
      ...(u.items.length ? u.items.map(b => el('div', { class: 'tx', style: 'grid-template-columns:1fr auto auto' },
        el('div', { style: 'min-width:0' }, el('div', { class: 'payee' }, b.name), el('div', { class: 'sub ' + (b.overdue ? 'neg' : '') }, (b.overdue ? 'Past due · ' : 'Due ') + shortDay(b.due) + (b.autopay ? ' · autopay' : ''))),
        el('div', { class: 'amt' }, fmt(b.amount_cents)),
        el('button', { class: 'btn small primary', onclick: () => { sheet.close(); openTxSheet(null, { bill: b }); } }, 'Pay')))
        : [el('div', { class: 'empty' }, 'Nothing else is due before payday.')]));
    openBillsSheetRefresh = () => { sheet.close(); openBillsSheet(); };
  }
  function openMatch(txId, m) {
    const sheet = openSheet('Mark it paid in Bill Pay?',
      el('p', {}, 'This looks like your ', el('b', {}, `${m.month_label} ${m.name}`), ` bill (due ${shortDay(m.due)}${m.amount_cents ? ', usually ' + fmt(m.amount_cents) : ''}).`),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', onclick: () => sheet.close() }, 'No'),
        el('button', { class: 'btn primary', onclick: async () => {
          sheet.close();
          try { await api('/bills/link', { method: 'POST', body: { tx_id: txId, bill_id: m.bill_id, month: m.month } }); toast('Marked paid in Bill Pay', 3000); route(state.view); }
          catch (e) { toast(e.message, 4000); }
        } }, 'Yes, mark paid')));
  }

  // ---------------- reconcile ----------------
  async function openReconcile(a) {
    const stmt = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: '$0.00' });
    const clearedEl = el('b', { class: 'mono' }, fmt(a.cleared_balance)), diffEl = el('b', { class: 'mono' }, '—');
    const pendingList = el('div');
    let pending = [];
    const refresh = async () => {
      await loadAccounts(); a = curAccount(); clearedEl.textContent = fmt(a.cleared_balance);
      const v = Math.round(parseFloat(String(stmt.value).replace(/[^0-9.\-]/g, '')) * 100);
      if (Number.isFinite(v)) { const d = a.cleared_balance - v; diffEl.textContent = d === 0 ? '$0.00 ✓ Balanced' : fmt(d); diffEl.className = 'mono ' + (d === 0 ? 'pos' : 'neg'); }
      pending = await api(`/transactions?account=${a.id}&status=open&limit=500`);
      pendingList.replaceChildren(...pending.map(t => el('div', { class: 'tx' },
        el('button', { class: 'st', onclick: async () => { await api(`/transactions/${t.id}`, { method: 'PATCH', body: { status: 'cleared' } }); refresh(); } }, ''),
        el('div', { style: 'min-width:0' }, el('div', { class: 'payee' }, t.payee || '(no payee)'), el('div', { class: 'sub' }, niceDate(t.date) + (t.check_no ? ' · #' + t.check_no : ''))),
        el('div', { class: 'amt ' + (t.amount < 0 ? 'neg' : 'pos') }, fmt(t.amount)))));
      if (!pending.length) pendingList.replaceChildren(el('div', { class: 'muted small center', style: 'padding:12px' }, 'Nothing pending — everything is cleared.'));
    };
    stmt.oninput = refresh;
    const sheet = openSheet('Reconcile with statement',
      el('label', { class: 'field' }, el('span', {}, 'Statement ending balance'), stmt),
      el('div', { class: 'card' }, el('div', { class: 'row' }, el('span', { class: 'grow muted' }, 'Cleared balance in app'), clearedEl), el('div', { class: 'row' }, el('span', { class: 'grow muted' }, 'Difference'), diffEl)),
      el('p', { class: 'muted small' }, 'Tap the circle on each pending item that shows on your statement until the difference is $0.00.'),
      pendingList,
      el('button', { class: 'btn block', style: 'margin-top:10px', onclick: async () => { if (!pending.length || !confirm(`Mark all ${pending.length} pending items cleared?`)) return; await api('/clear-all', { method: 'POST', body: { ids: pending.map(t => t.id) } }); refresh(); } }, 'Clear everything pending'),
      el('button', { class: 'btn primary block', style: 'margin-top:10px', onclick: () => { sheet.close(); route('register'); } }, 'Done'));
    refresh(); setTimeout(() => stmt.focus(), 80);
  }

  function autocompleteWrap(input, getItems, onPick) {
    const wrap = el('div', { class: 'dl' }, input);
    const list = el('div', { class: 'list', hidden: true });
    wrap.append(list);
    let hl = -1;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const items = getItems().filter(i => i.v && (!q || i.v.toLowerCase().includes(q)) && i.v.toLowerCase() !== q).slice(0, 8);
      list.replaceChildren(...items.map((i, idx) => el('button', { type: 'button', class: idx === hl ? 'hl' : '', onmousedown: e => e.preventDefault(), onclick: () => { input.value = i.v; list.hidden = true; onPick && onPick(i); input.dispatchEvent(new Event('change')); } }, i.v, i.sub ? el('small', {}, i.sub) : null)));
      list.hidden = !items.length;
    };
    input.addEventListener('input', () => { hl = -1; render(); });
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(() => list.hidden = true, 150));
    input.addEventListener('keydown', e => {
      const n = list.children.length; if (list.hidden || !n) return;
      if (e.key === 'ArrowDown') { hl = (hl + 1) % n; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hl = (hl - 1 + n) % n; render(); e.preventDefault(); }
      else if (e.key === 'Enter' && hl >= 0) { list.children[hl].click(); e.preventDefault(); }
      else if (e.key === 'Escape') list.hidden = true;
    });
    return wrap;
  }

  function openSheet(title, ...content) {
    const root = $('#sheet-root');
    const back = el('div', { class: 'sheet-back', onclick: e => { if (e.target === back) close(); } },
      el('div', { class: 'sheet' }, el('div', { class: 'handle' }), el('h2', {}, title), ...content));
    const close = () => back.remove();
    root.append(back);
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    return { close, el: back };
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------------- reports ----------------
  async function viewReports() {
    await loadAccounts();
    setTop('Reports'); setNav('reports');
    const now = new Date();
    const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const from = el('input', { class: 'input', type: 'date', value: first }), to = el('input', { class: 'input', type: 'date', value: today() });
    const acct = el('select', { class: 'input' }, el('option', { value: '' }, 'All accounts'), ...state.accounts.map(a => el('option', { value: a.id }, a.name)));
    const out = el('div');
    const run = async () => {
      const p = new URLSearchParams({ from: from.value, to: to.value }); if (acct.value) p.set('account', acct.value);
      const rows = await api('/summary?' + p);
      const spent = rows.reduce((s, r) => s + r.spent, 0), rec = rows.reduce((s, r) => s + r.received, 0);
      out.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'stats' }, el('div', {}, el('div', { class: 'muted small' }, 'Spent'), el('div', { class: 'mono neg stat' }, fmt(spent))), el('div', {}, el('div', { class: 'muted small' }, 'Received'), el('div', { class: 'mono pos stat' }, fmt(rec))), el('div', {}, el('div', { class: 'muted small' }, 'Net'), el('div', { class: 'mono stat' }, fmt(rec - spent))))),
        el('div', { class: 'card' }, el('h2', {}, 'Spending by category'),
          rows.filter(r => r.spent).length ? rows.filter(r => r.spent).map(r => el('div', { style: 'margin-bottom:10px' },
            el('div', { class: 'row' }, el('div', { class: 'grow' }, r.category || el('i', { class: 'muted' }, 'Uncategorized')), el('div', { class: 'mono' }, fmt(r.spent)), el('div', { class: 'muted small', style: 'width:40px;text-align:right' }, Math.round(r.spent / spent * 100) + '%')),
            el('div', { class: 'bar' }, el('div', { style: `width:${r.spent / spent * 100}%` })))) : el('div', { class: 'muted' }, 'No spending in this period.')));
    };
    [from, to, acct].forEach(i => i.onchange = run);
    view.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'From'), from), el('label', { class: 'field' }, el('span', {}, 'To'), to)), el('label', { class: 'field' }, el('span', {}, 'Account'), acct)), out);
    run();
  }

  // ---------------- settings ----------------
  async function viewSettings() {
    setTop('Settings', state.user.username + (state.user.role === 'admin' ? ' · admin' : '')); setNav('settings');
    const isAdmin = state.user.role === 'admin';
    const users = await api('/users');
    const batches = await api('/import/batches').catch(() => []);
    const appsCard = NATIVE ? null : el('div', { class: 'card' }, el('h2', {}, 'Root Cellar apps'),
      el('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'The Windows and Android apps keep their own copy of everything, so they open and work even when the server is down. Changes sync when it is back.'),
      el('div', { class: 'muted small' }, 'Get them from the "apps" folder of the Root Cellar download (root-cellar-checkbook.apk for Android, the Setup .exe for Windows). On iPhone, use "Add to Home Screen" below — it keeps an offline copy too.'));
    const installCard = NATIVE ? null : el('div', { class: 'card' }, el('h2', {}, 'Install as an app'),
      deferredInstall ? el('button', { class: 'btn primary', onclick: async () => { deferredInstall.prompt(); } }, 'Install Checkbook') :
      el('div', { class: 'small muted' }, /iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone: tap the Share button in Safari, then "Add to Home Screen".' : window.matchMedia('(display-mode: standalone)').matches ? 'Already installed.' : 'Open this page over HTTPS, then use your browser\'s "Install app" or "Add to Home Screen" option.'));
    const backupStatusEl = el('div', { class: 'small muted' });
    api('/backup-status').then(b => {
      if (!b) return;
      const when = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
      backupStatusEl.replaceChildren(
        el('div', {}, `Nightly backup on the server: ${when(b.last)} (keeps ${b.keep} days)`),
        b.offsite_configured ? el('div', { class: b.offsite_error ? 'neg' : 'pos' }, b.offsite_error ? `Second-drive backup: ${b.offsite_error}` : `Second-drive backup: ${when(b.offsite_last)} · ${b.offsite_count} copies`) : el('div', {}, 'Second-drive backup: not set up (optional)'),
        isAdmin ? el('button', { class: 'btn small', style: 'margin-top:8px', onclick: async e => { e.target.disabled = true; try { const r = await api('/backup-now', { method: 'POST' }); toast(r.offsite_error ? 'Saved on the server — second-drive copy failed' : 'Backed up now', 3000); route('settings'); } catch (ex) { toast(ex.message); e.target.disabled = false; } } }, 'Back up now') : null);
    }).catch(() => {});
    const dataCard = el('div', { class: 'card stack' }, el('h2', {}, 'Data'),
      el('button', { class: 'btn block', onclick: () => route('import') }, 'Import from another app (CSV / QIF)'),
      el('button', { class: 'btn block', onclick: () => dl('/export.csv', `checkbook-${today()}.csv`) }, 'Export everything as CSV'),
      isAdmin ? el('button', { class: 'btn block', onclick: () => dl('/backup.db', `checkbook-backup-${today()}.db`) }, 'Download database backup') : null,
      backupStatusEl,
      batches.length ? el('div', {}, el('div', { class: 'muted small', style: 'margin:8px 0 4px' }, 'Past imports'), ...batches.map(b => el('div', { class: 'userrow' }, el('div', { class: 'grow small' }, el('b', {}, b.filename || b.source), el('div', { class: 'muted' }, `${b.row_count} rows · ${b.user_name || ''} · ${new Date(b.created_at.replace(' ', 'T') + 'Z').toLocaleString()}`)), el('button', { class: 'btn small danger', onclick: async () => { if (!confirm(`Undo this import and delete its ${b.row_count} transactions?`)) return; await api(`/import/batches/${b.id}`, { method: 'DELETE' }); toast('Import removed'); route('settings'); } }, 'Undo')))) : null);
    const userCard = el('div', { class: 'card' }, el('h2', {}, 'Users'),
      ...users.map(u => el('div', { class: 'userrow' }, el('div', { class: 'grow' }, el('b', {}, u.display_name), ' ', el('span', { class: 'muted small' }, '@' + u.username), ' ', u.role === 'admin' ? el('span', { class: 'badge' }, 'admin') : null),
        isAdmin ? el('button', { class: 'btn small', onclick: () => openUserSheet(u) }, 'Edit') : null)),
      isAdmin ? el('button', { class: 'btn block', style: 'margin-top:10px', onclick: () => openUserSheet() }, 'Add user') : null);
    const curTheme = localStorage.getItem('cb.theme') || 'system';
    const themeCard = el('div', { class: 'card' }, el('h2', {}, 'Appearance'),
      el('div', { class: 'seg' }, ...[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) =>
        el('button', { type: 'button', class: curTheme === v ? 'on' : '', onclick: e => { localStorage.setItem('cb.theme', v); applyTheme(v); e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); } }, label))),
      el('div', { class: 'muted small', style: 'margin-top:14px' }, 'Color'),
      el('div', { class: 'swatches' }, ...ACCENTS.map(([k, label, color]) => el('button', { type: 'button', class: 'swatch' + ((localStorage.getItem('cb.accent') || 'forest') === k ? ' on' : ''), style: `--sw:${color}`, title: label, 'aria-label': label, onclick: e => { localStorage.setItem('cb.accent', k); applyAccent(k); e.currentTarget.parentNode.querySelectorAll('.swatch').forEach(b => b.classList.toggle('on', b === e.currentTarget)); toast(label); } }, el('span', {}, label)))),
      el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Saved on this device only, so each person can pick their own.'));
    const featToggle = el('input', { type: 'checkbox', checked: state.bills, disabled: !isAdmin, onchange: async () => {
      try { const r = await api('/features', { method: 'PUT', body: { bills: featToggle.checked } }); state.bills = r.bills; state.billpay = r.bills || r.external_billpay; toast(r.bills ? 'Bills turned on' : 'Bills turned off'); route('settings'); }
      catch (e) { toast(e.message); featToggle.checked = !featToggle.checked; }
    } });
    const billsFile = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
      const f = billsFile.files[0]; if (!f) return;
      try { const data = JSON.parse(await f.text()); const r = await api('/bills/import', { method: 'POST', body: { data } }); toast(`Imported ${r.bills} bills and ${r.payments} payments`, 4000); route('settings'); }
      catch (e) { toast(e.message, 4000); }
    } });
    const featCard = el('div', { class: 'card' }, el('h2', {}, 'Features'),
      el('label', { class: 'row' }, featToggle, el('span', { class: 'grow' }, el('b', {}, 'Bills'), el('div', { class: 'muted small' }, 'Monthly bill checklist, Affirm/Klarna plans, autopay, and "safe to spend". Marking a bill paid posts it to the register.'))),
      !isAdmin ? el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Only an admin can turn features on or off.') : null,
      state.bills && isAdmin ? el('div', { class: 'row', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn small', onclick: () => billsFile.click() }, 'Import bills (JSON)'), billsFile,
        el('button', { class: 'btn small', onclick: () => dl('/bills/export.json', `billpay-${today()}.json`) }, 'Export bills (JSON)')) : null);
    let bpCard = null;
    if (state.billpay) {
      const st = await api('/link-settings').catch(() => null);
      if (st && st.enabled) {
        const saveLink = async body => { try { await api('/link-settings', { method: 'PUT', body }); toast('Saved'); } catch (e) { toast(e.message); } };
        const acctSel = el('select', { class: 'input', onchange: () => saveLink({ account: Number(acctSel.value) }) }, ...state.accounts.map(a => el('option', { value: a.id, selected: a.id === st.account }, a.name)));
        // Paydays: one row per person; "safe to spend" runs to whichever comes first.
        const paydays = (st.paydays && st.paydays.length) ? st.paydays.map(p => ({ ...p })) : (st.payday && st.payday.all ? st.payday.all.map(p => ({ label: p.label, anchor: p.anchor, every: p.every })) : []);
        const pdList = el('div', { class: 'stack' });
        const savePaydays = () => saveLink({ paydays: paydays.filter(p => p.anchor) });
        const renderPaydays = () => {
          pdList.replaceChildren(...paydays.map((p, i) => {
            const label = autoCap(el('input', { class: 'input', placeholder: 'Whose / what', value: p.label, onchange: e => { p.label = e.target.value; savePaydays(); } }));
            const date = el('input', { class: 'input', type: 'date', value: p.anchor, onchange: e => { p.anchor = e.target.value; savePaydays(); } });
            const every = el('select', { class: 'input', onchange: e => { p.every = Number(e.target.value); savePaydays(); } }, ...[[7, 'Weekly'], [14, '2 weeks'], [28, '4 weeks'], [30, 'Monthly']].map(([v, l]) => el('option', { value: v, selected: p.every === v }, l)));
            const amt = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Varies', value: p.amount_cents ? (p.amount_cents / 100).toFixed(2) : '', onchange: e => { p.amount_cents = Math.round(parseFloat(String(e.target.value).replace(/[^0-9.]/g, '')) * 100) || 0; savePaydays(); } });
            return el('div', { class: 'card', style: 'padding:10px 12px;margin:0' },
              el('div', { class: 'row', style: 'margin-bottom:8px' }, el('div', { class: 'grow' }, label), el('button', { class: 'btn small danger', 'aria-label': 'Remove payday', onclick: () => { paydays.splice(i, 1); renderPaydays(); savePaydays(); } }, '✕')),
              el('div', { class: 'grid2' }, el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Next payday'), date), el('label', { class: 'field', style: 'margin:0' }, el('span', {}, 'Paid'), every)),
              el('label', { class: 'field', style: 'margin:10px 0 0' }, el('span', {}, 'Usual amount (leave blank if it varies)'), amt));
          }),
          el('button', { class: 'btn small', onclick: () => { paydays.push({ label: paydays.length ? '' : state.user.display_name, anchor: '', every: 14 }); renderPaydays(); setTimeout(() => { const d = pdList.querySelectorAll('input[type=date]'); d[d.length - 1].focus(); }, 50); } }, '+ Add a payday'));
        };
        renderPaydays();
        const auto = el('input', { type: 'checkbox', checked: st.autopay, onchange: () => saveLink({ autopay: auto.checked }) });
        bpCard = el('div', { class: 'card' }, el('h2', {}, st.mode === 'builtin' ? 'Bills settings' : 'Bill Pay link'),
          st.mode === 'builtin' ? null : el('div', { class: 'row', style: 'margin-bottom:10px' }, el('span', { class: 'grow muted small' }, 'Status'), el('b', { class: st.error && !st.last_ok ? 'neg' : 'pos' }, st.error && !st.last_ok ? "Can't connect" : 'Connected')),
          el('label', { class: 'field' }, el('span', {}, 'Bills are paid from'), acctSel),
          el('div', { class: 'muted small', style: 'margin:0 0 8px;font-weight:600' }, 'Paydays'),
          el('div', { class: 'muted small', style: 'margin:0 0 8px' }, !st.payday ? 'Add each person\'s payday so "safe to spend" knows how far ahead to look.' : st.payday_manual ? `"Safe to spend" covers bills due before the next one: ${new Date(st.payday.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} (${st.payday.label}).` : `Worked out from your ${st.payday.label || 'paycheck'} deposits — edit or add to it if that's not right.`),
          pdList,
          el('div', { class: 'muted small', style: 'margin:8px 0 12px' }, 'A paycheck posts to the register at 5:00 AM on the payday. Until then it is never counted as available, even if you\'ve entered the amount ahead of time (Register → Upcoming → Paychecks).'),
          el('label', { class: 'row small' }, auto, ' Autopay bills mark themselves paid on their due date'),
          st.mode === 'builtin' ? null : el('button', { class: 'btn small', style: 'margin-top:10px', onclick: async () => { await api('/bills/sync', { method: 'POST' }); toast('Synced'); } }, 'Sync now'));
      }
    }
    const meCard = el('div', { class: 'card stack' }, el('h2', {}, 'Your account'),
      el('button', { class: 'btn block', onclick: openPasswordSheet }, 'Change my password'),
      el('button', { class: 'btn block', onclick: async () => {
        const n = Sync.status().pending;
        if (n && !confirm(`${n} change${n === 1 ? ' has' : 's have'} not reached the server yet. Signing out deletes ${n === 1 ? 'it' : 'them'} from this device. Sign out anyway?`)) return;
        await Sync.logout(); state.user = null; route('login');
      } }, 'Sign out'),
      el('div', { class: 'muted small center' }, (NATIVE ? `Root Cellar Checkbook for ${NATIVE.platform === 'android' ? 'Android' : 'Windows'} v${NATIVE.version || ''} · ` : '') + 'Server v' + (state.version || '')));
    view.replaceChildren(...[offlineCard(), appsCard, installCard, featCard, bpCard, themeCard, dataCard, userCard, meCard].filter(Boolean));
  }
  async function dl(path, name) { try { toast('Downloading…'); await Sync.download(path, name); } catch (e) { toast(e.message, 4000); } }
  function offlineCard() {
    const st = Sync.status();
    const notes = st.notes || [];
    return el('div', { class: 'card' }, el('h2', {}, 'Offline copy'),
      el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Server'), el('b', { class: st.online === false ? 'neg' : 'pos' }, st.online === false ? "Can't reach it" : 'Connected')),
      el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Last synced'), el('b', {}, when(st.lastSync))),
      el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Saved on this device'), el('b', {}, `${st.entries.toLocaleString()} entries`)),
      el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Waiting to sync'), el('b', { class: st.pending ? 'warnc' : '' }, st.pending ? String(st.pending) : 'nothing')),
      st.pending ? el('ul', { class: 'small muted', style: 'margin:6px 0 0 18px;padding:0' }, ...st.pendingList.slice(0, 10).map(x => el('li', {}, x))) : null,
      NATIVE ? el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Server address'), el('span', { class: 'mono', style: 'font-size:12px;overflow-wrap:anywhere;text-align:right' }, Sync.server())) : null,
      el('p', { class: 'muted small', style: 'margin:10px 0' }, 'If the server goes down you still see everything as of the last sync, and you can keep adding entries, transfers, cleared marks and bill payments. They sync on their own when it is back. Paychecks still count from 5 AM on payday.'),
      notes.length ? el('details', { open: notes.some(n => Date.now() - new Date(n.at) < 86400000) }, el('summary', { class: 'small' }, `Sync notes (${notes.length})`),
        ...notes.map(n => el('div', { class: 'small', style: 'padding:6px 0;border-top:1px solid var(--line)' }, el('div', { class: 'muted' }, when(n.at)), n.msg)),
        el('button', { class: 'btn small', style: 'margin-top:6px', onclick: () => { Sync.clearNotes(); route('settings'); } }, 'Clear notes')) : null,
      el('button', { class: 'btn small', style: 'margin-top:10px', onclick: async e => { e.target.disabled = true; try { await Sync.flush(); await Sync.pull(); toast('Synced'); } catch (ex) { toast(ex.offline ? "Still can't reach the server" : ex.message, 3500); } route('settings'); } }, 'Sync now'));
  }
  function openUserSheet(u) {
    const username = el('input', { class: 'input', placeholder: 'username', value: u ? u.username : '', disabled: !!u, autocapitalize: 'none' });
    const display = el('input', { class: 'input', placeholder: 'Display name', value: u ? u.display_name : '' });
    const pass = el('input', { class: 'input', type: 'password', placeholder: u ? 'New password (leave blank to keep)' : 'Password (8+ characters)', autocomplete: 'new-password' });
    const role = el('select', { class: 'input', disabled: u && u.id === state.user.id }, el('option', { value: 'user', selected: !u || u.role === 'user' }, 'User'), el('option', { value: 'admin', selected: u && u.role === 'admin' }, 'Admin'));
    const err = el('div', { class: 'err' });
    const sheet = openSheet(u ? 'Edit user' : 'Add user',
      el('label', { class: 'field' }, el('span', {}, 'Username'), username), el('label', { class: 'field' }, el('span', {}, 'Display name'), display),
      el('label', { class: 'field' }, el('span', {}, 'Password'), pass), el('label', { class: 'field' }, el('span', {}, 'Role'), role), err,
      el('div', { class: 'btnrow' },
        u && u.id !== state.user.id ? el('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete ${u.display_name}? Their transactions stay.`)) return; await api(`/users/${u.id}`, { method: 'DELETE' }); sheet.close(); route('settings'); } }, 'Delete') : null,
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            const body = { username: username.value, display_name: display.value, password: pass.value || undefined, role: role.value };
            if (u) await api(`/users/${u.id}`, { method: 'PATCH', body }); else await api('/users', { method: 'POST', body });
            sheet.close(); toast('Saved'); route('settings');
          } catch (ex) { err.textContent = ex.message; }
        } }, 'Save')));
  }
  function openPasswordSheet() {
    const cur = el('input', { class: 'input', type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const nw = el('input', { class: 'input', type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
    const err = el('div', { class: 'err' });
    const sheet = openSheet('Change password', cur, el('div', { style: 'height:10px' }), nw, err, el('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: async () => {
      try { await api('/me/password', { method: 'POST', body: { current: cur.value, password: nw.value } }); sheet.close(); toast('Password changed'); } catch (ex) { err.textContent = ex.message; }
    } }, 'Update'));
  }

  // ---------------- import wizard ----------------
  async function viewImport() {
    await loadAccounts();
    setTop('Import', 'from another checkbook app', [el('button', { class: 'icon', 'aria-label': 'Back', onclick: () => route('settings') }, '←')]); setNav('settings');
    const file = el('input', { type: 'file', accept: '.csv,.txt,.qif,text/csv,text/plain' });
    const dayFirst = el('input', { type: 'checkbox' }), invert = el('input', { type: 'checkbox' }), noHeader = el('input', { type: 'checkbox' });
    const out = el('div');
    let fileText = '', fileName = '', preview = null, mapping = null;
    const FIELDS = [['date', 'Date *'], ['amount', 'Amount (signed)'], ['withdrawal', 'Withdrawal / debit'], ['deposit', 'Deposit / credit'], ['payee', 'Payee'], ['category', 'Category'], ['memo', 'Memo / note'], ['check_no', 'Check #'], ['status', 'Cleared status'], ['account', 'Account name']];
    async function runPreview() {
      out.replaceChildren(el('div', { class: 'loading' }, 'Reading file…'));
      try {
        preview = await api('/import/preview', { method: 'POST', body: { filename: fileName, text: fileText, mapping, hasHeader: !noHeader.checked, dayFirst: dayFirst.checked, invertAmounts: invert.checked } });
        if (preview.format === 'csv') mapping = preview.mapping;
        renderPreview();
      } catch (ex) { out.replaceChildren(el('div', { class: 'err' }, ex.message)); }
    }
    function renderPreview() {
      const p = preview; const parts = [];
      if (p.format === 'csv') {
        parts.push(el('div', { class: 'card' }, el('h2', {}, 'Match columns'),
          el('p', { class: 'small muted' }, 'I guessed these from the headers. Fix any that are wrong. Either a signed Amount column, or separate Withdrawal and Deposit columns, is required.'),
          el('table', { class: 'map' }, ...FIELDS.map(([f, label]) => el('tr', {}, el('td', { style: 'width:45%' }, label), el('td', {},
            el('select', { class: 'input', onchange: e => { mapping = { ...mapping }; if (e.target.value === '') delete mapping[f]; else mapping[f] = Number(e.target.value); runPreview(); } },
              el('option', { value: '' }, '— not in file —'), ...p.headers.map((h, i) => el('option', { value: i, selected: mapping[f] === i }, h || `Column ${i + 1}`))))))),
          el('div', { class: 'preview', style: 'margin-top:10px' }, el('table', {}, el('tr', {}, ...p.headers.map(h => el('th', {}, h))), ...p.sample.map(r => el('tr', {}, ...r.map(c => el('td', {}, c))))))));
      }
      const txs = p.transactions;
      const neg = txs.filter(t => t.amount < 0).length, pos = txs.length - neg;
      const sum = txs.reduce((s, t) => s + t.amount, 0);
      const dates = txs.map(t => t.date).sort();
      // account mapping
      const accountMap = {};
      const acctSel = key => { const s = el('select', { class: 'input', onchange: () => { accountMap[key] = s.value; } },
        el('option', { value: '' }, key ? `Create "${key}"` : 'Choose…'), ...state.accounts.map(a => el('option', { value: a.id, selected: a.name.toLowerCase() === key.toLowerCase() }, a.name)));
        if (s.value) accountMap[key] = s.value; return s; };
      const acctRows = p.accountsInFile.length ? p.accountsInFile.map(k => el('tr', {}, el('td', {}, k), el('td', {}, acctSel(k)))) : [el('tr', {}, el('td', {}, 'All rows'), el('td', {}, acctSel('')))];
      parts.push(el('div', { class: 'card' }, el('h2', {}, 'Accounts'),
        el('p', { class: 'small muted' }, p.accountsInFile.length ? 'The file names these accounts. Pick where each one goes.' : 'The file has no account column, so pick the account these go into.'),
        el('table', { class: 'map' }, ...acctRows)));
      parts.push(el('div', { class: 'card' }, el('h2', {}, 'Check the numbers'),
        el('div', { class: 'stats' }, el('div', {}, el('div', { class: 'muted small' }, 'Transactions'), el('div', { class: 'stat' }, txs.length), el('div', { class: 'muted small' }, dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '')), el('div', {}, el('div', { class: 'muted small' }, 'Withdrawals / deposits'), el('div', { class: 'stat' }, el('span', { class: 'neg' }, neg), ' / ', el('span', { class: 'pos' }, pos))), el('div', {}, el('div', { class: 'muted small' }, 'Net'), el('div', { class: 'stat mono' }, fmt(sum)))),
        neg === 0 && pos > 5 || pos === 0 && neg > 5 ? el('div', { class: 'err', style: 'margin-top:8px' }, 'Everything is one direction — if that looks wrong, tick "Flip signs" above or map Withdrawal/Deposit columns.') : null,
        p.errors.length ? el('details', { style: 'margin-top:8px' }, el('summary', { class: 'small' }, `${p.errors.length} rows will be skipped`), el('div', { class: 'preview' }, el('table', {}, ...p.errors.slice(0, 50).map(e => el('tr', {}, el('td', {}, 'line ' + e.line), el('td', {}, e.error), el('td', {}, (e.row || []).join(' | '))))))) : null,
        el('div', { class: 'preview', style: 'margin-top:10px' }, el('table', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', {}, 'Category'), el('th', {}, 'Amount'), el('th', {}, 'Status')), ...txs.slice(0, 8).map(t => el('tr', {}, el('td', {}, t.date), el('td', {}, t.payee), el('td', {}, t.category), el('td', { class: t.amount < 0 ? 'neg' : 'pos' }, fmt(t.amount)), el('td', {}, t.status)))))));
      const skipDup = el('input', { type: 'checkbox', checked: true });
      const err = el('div', { class: 'err' });
      parts.push(el('div', { class: 'card stack' },
        el('label', { class: 'row small' }, skipDup, ' Skip rows that already exist (same account, date, payee and amount)'),
        err,
        el('button', { class: 'btn primary block', disabled: !txs.length, onclick: async e => {
          e.target.disabled = true; err.textContent = '';
          try {
            const r = await api('/import/commit', { method: 'POST', body: { transactions: txs, accountMap, defaultAccountId: accountMap[''] || null, source: p.format, filename: fileName, skipDuplicates: skipDup.checked } });
            toast(`Imported ${r.inserted} transactions${r.skipped ? `, skipped ${r.skipped}` : ''}`, 4000);
            await loadAccounts(); route('accounts');
          } catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
        } }, `Import ${txs.length} transactions`)));
      out.replaceChildren(...parts);
    }
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      fileName = f.name; fileText = await f.text(); mapping = null; runPreview();
    };
    [dayFirst, invert, noHeader].forEach(c => c.onchange = () => { if (fileText) { mapping = null; runPreview(); } });
    view.replaceChildren(
      el('div', { class: 'card stack' },
        el('p', { class: 'small muted', style: 'margin:0' }, 'Export a CSV or QIF from your old app (Checkbook - Account Tracker: Settings → Export), then pick the file here. Nothing is saved until you press Import at the bottom, and any import can be undone from Settings.'),
        file,
        el('label', { class: 'row small' }, dayFirst, ' Dates are day/month/year'),
        el('label', { class: 'row small' }, invert, ' Flip signs (file shows spending as positive)'),
        el('label', { class: 'row small' }, noHeader, ' File has no header row')),
      out);
  }

  // ---------------- PWA plumbing ----------------
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Live refresh between phones: the sync engine checks the server every 10 seconds and fires 'change' when something moved.
  // Android back button: close the open sheet first.
  window.CBNativeBack = () => { const s = $('#sheet-root .sheet-back:last-child'); if (s) { s.remove(); return true; } if (state.view !== 'register' && state.view !== 'login' && state.user) { route('register'); return true; } return false; };

  // ---------------- boot ----------------
  (async () => {
    try {
      await Sync.ready;
      if (NATIVE && !Sync.hasToken()) return route('login');
      const s = await api('/status');
      state.version = s.version; state.rev = s.rev; state.billpay = !!s.billpay; state.bills = !!s.bills;
      if (s.needsSetup) return route('setup');
      if (!s.user) return route('login');
      state.user = s.user; state.offline = !!s.offline;
      await loadAccounts();
      route(state.accounts.length ? 'register' : 'accounts');
      if (!Sync.status().hasCopy || !s.offline) Sync.pull().catch(() => {});
    } catch (e) {
      setTop('Checkbook');
      view.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📡'), e.message || "Can't reach the server.", el('div', { style: 'margin-top:14px' },
        el('button', { class: 'btn', onclick: () => location.reload() }, 'Retry'), NATIVE ? ' ' : null, NATIVE ? el('button', { class: 'btn', onclick: () => route('login') }, 'Change server') : null)));
    }
  })();
})();

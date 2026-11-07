/* Bills tab — built-in bill tracker. Loaded after app.js and registers itself via window.CB. */
(() => {
  const { $, el, fmt, api, state, route, setTop, setNav, openSheet, toast, titleCase, autoCap, autocompleteWrap } = window.CB;
  const BNPL = 'Buy Now Pay Later';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');
  const now = () => new Date();
  const curKey = () => `${now().getFullYear()}-${pad(now().getMonth() + 1)}`;
  const monthLabel = k => { const [y, m] = k.split('-').map(Number); return `${MON[m - 1]} ${y}`; };
  const monthAdd = (k, n) => { const [y, m] = k.split('-').map(Number); const i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`; };
  const monthsBetween = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
  const daysIn = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const ord = d => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
  const isActive = b => b.status !== 'Paid off' && b.status !== 'Paused';
  const needsDetails = b => !b.item || !b.ends;

  const V = { month: curKey(), filter: 'all', tab: 'bills', data: null, openId: null };
  const payOf = (mk, id) => V.data && V.data.months[mk] ? V.data.months[mk][id] : null;
  function billState(b, mk) {
    const p = payOf(mk, b.id); if (p) return { kind: 'paid', p };
    const ck = curKey(); if (mk < ck) return { kind: 'missed' }; if (mk > ck) return { kind: 'later' };
    const due = Math.min(b.due, daysIn(mk)), d = now().getDate();
    if (due < d) return { kind: 'overdue' }; if (due - d <= 7) return { kind: 'soon' }; return { kind: 'later' };
  }
  const paymentsLeft = b => !b.ends ? null : Math.max(0, monthsBetween(curKey(), b.ends) + (payOf(curKey(), b.id) ? 0 : 1));

  async function load() { V.data = await api('/bills'); }

  // ---------------- main view ----------------
  async function viewBills() {
    await load();
    setTop('Bills', monthLabel(V.month), [el('button', { class: 'icon', 'aria-label': 'Add bill', onclick: () => openBillForm() }, '+')]);
    setNav('bills');
    const root = el('div');
    view().replaceChildren(root);
    render(root);
  }
  const view = () => $('#view');

  function render(root) {
    const d = V.data, mk = V.month, all = Object.values(d.bills).sort((a, b) => a.order - b.order || a.due - b.due || a.name.localeCompare(b.name));
    const N = d.settings.names;
    const monthNav = el('div', { class: 'monthnav' },
      el('button', { class: 'btn small', onclick: () => { V.month = monthAdd(V.month, -1); viewBills(); } }, '‹'),
      el('div', { class: 'grow center', style: 'font-weight:650;align-self:center' }, monthLabel(mk)),
      mk === curKey() ? null : el('button', { class: 'btn small', onclick: () => { V.month = curKey(); viewBills(); } }, 'Today'),
      el('button', { class: 'btn small', onclick: () => { V.month = monthAdd(V.month, 1); viewBills(); } }, '›'));
    const seg = el('div', { class: 'seg', style: 'margin-bottom:12px' },
      el('button', { type: 'button', class: V.tab === 'bills' ? 'on' : '', onclick: () => { V.tab = 'bills'; render(root); } }, 'Bills'),
      el('button', { type: 'button', class: V.tab === 'plans' ? 'on' : '', onclick: () => { V.tab = 'plans'; render(root); } }, 'Affirm / Klarna plans'));
    root.replaceChildren(monthNav, seg, V.tab === 'bills' ? renderBills(all, mk, N) : renderPlans(all, N));
  }

  function renderBills(all, mk, N) {
    const active = all.filter(isActive);
    let total = 0, paid = 0, left = 0, od = 0, odAmt = 0, soon = 0, h1 = 0, h2 = 0;
    for (const b of active) {
      const s = billState(b, mk), amt = b.amount_cents; total += amt;
      if (s.kind === 'paid') { paid += s.p.amount_cents; continue; }
      left += amt; if (b.due <= 15) h1 += amt; else h2 += amt;
      if (s.kind === 'overdue' || s.kind === 'missed') { od++; odAmt += amt; }
      if (s.kind === 'soon') soon += amt;
    }
    const pct = total ? Math.min(100, Math.round((total - left) / total * 100)) : 0;
    const summary = el('div', { class: 'card' },
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('div', { class: 'stat', style: 'font-size:26px' }, fmt(left)), el('div', { class: 'muted small' }, 'left to pay of ' + fmt(total))), el('div', { class: 'muted small' }, pct + '% done')),
      el('div', { class: 'bar', style: 'margin:10px 0 12px' }, el('div', { style: `width:${pct}%` })),
      el('div', { class: 'stats' },
        el('div', {}, el('div', { class: 'muted small' }, 'Paid'), el('div', { class: 'stat pos' }, fmt(paid))),
        el('div', {}, el('div', { class: 'muted small' }, mk < curKey() ? 'Not marked' : 'Past due'), el('div', { class: 'stat ' + (od ? 'neg' : '') }, od ? `${od} · ${fmt(odAmt)}` : '0')),
        el('div', {}, el('div', { class: 'muted small' }, 'Next 7 days'), el('div', { class: 'stat warnc' }, fmt(soon)))),
      el('div', { class: 'row muted small', style: 'margin-top:10px' }, el('span', { class: 'grow' }, `Due 1st–15th · left ${fmt(h1)}`), el('span', {}, `16th–31st · left ${fmt(h2)}`)));
    const people = [...new Set(all.map(b => b.who))].filter(w => w !== 'Household').sort();
    const chips = el('div', { class: 'chips', style: 'margin:0 0 12px' }, ...[['all', 'All'], ['unpaid', 'Unpaid'], ...people.map(p => [p, p]), ['Household', 'Household'], ['bnpl', 'Affirm / Klarna']].map(([k, l]) =>
      el('button', { class: 'chip' + (V.filter === k ? ' on' : ''), onclick: () => { V.filter = k; viewBills(); } }, l)));
    const passes = b => V.filter === 'all' || (V.filter === 'unpaid' ? !payOf(mk, b.id) : V.filter === 'bnpl' ? b.category === BNPL : b.who === V.filter);
    const groups = el('div');
    if (!all.length) groups.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🧾'), 'No bills yet. Tap + to add your first one.'));
    const shown = all.filter(passes);
    const defs = mk === curKey() ? [['overdue', 'Past due', 'neg'], ['soon', 'Due in the next 7 days', 'warnc'], ['later', 'Later this month', ''], ['paid', 'Paid', 'pos']]
      : mk < curKey() ? [['missed', 'Not marked paid', 'neg'], ['paid', 'Paid', 'pos']] : [['later', 'Coming up', ''], ['paid', 'Paid', 'pos']];
    const buckets = {};
    for (const b of shown.filter(isActive)) { const k = billState(b, mk).kind; (buckets[k] = buckets[k] || []).push(b); }
    for (const [k, label, tone] of defs) {
      const list = buckets[k]; if (!list || !list.length) continue;
      const sum = list.reduce((s, b) => s + (k === 'paid' ? payOf(mk, b.id).amount_cents : b.amount_cents), 0);
      groups.append(el('div', { class: 'daygroup row' }, el('span', { class: 'grow ' + tone }, label), el('span', {}, `${list.length} · ${fmt(sum)}`)));
      for (const b of list) groups.append(billRow(b, mk, N));
    }
    const inactive = shown.filter(b => !isActive(b));
    if (inactive.length) {
      const det = el('details', { style: 'margin-top:14px' }, el('summary', { class: 'muted small' }, `Paid off or paused (${inactive.length})`));
      for (const b of inactive) det.append(billRow(b, mk, N));
      groups.append(det);
    }
    return el('div', {}, summary, chips, groups);
  }

  function billRow(b, mk, N) {
    const s = billState(b, mk), paid = s.kind === 'paid';
    const ck = el('button', { class: 'st ' + (paid ? 'cleared' : ''), 'aria-label': (paid ? 'Unmark ' : 'Mark paid: ') + b.name, disabled: !isActive(b) && !paid, onclick: async e => {
      e.stopPropagation();
      try {
        if (paid) { if (!confirm(`Unmark ${b.name} as paid for ${monthLabel(mk)}? The register entry it created is removed too (unless it's already cleared).`)) return; await api('/bills/pay', { method: 'POST', body: { month: mk, bill_id: b.id, payment: null } }); toast(b.name + ' unmarked'); }
        else openPaySheet(b, mk);
        if (paid) viewBills();
      } catch (ex) { toast(ex.message, 4000); }
    } }, paid ? '✓' : '');
    const meta = [`Due ${ord(b.due)}`];
    if (b.autopay === 'Yes') meta.push('Autopay');
    if (b.who !== 'Household') meta.push(b.who);
    const pl = paymentsLeft(b);
    if (b.ends && isActive(b)) meta.push(pl <= 1 ? 'Last payment ' + monthLabel(b.ends) : pl + ' left');
    if (paid) { const d = new Date(s.p.at); meta.push('Paid' + (isNaN(d) ? '' : ` ${MON[d.getMonth()]} ${d.getDate()}`) + (s.p.by ? ' by ' + s.p.by : '')); }
    if (!isActive(b)) meta.push(b.status);
    return el('div', { class: 'tx ' + (paid ? 'cleared' : s.kind === 'overdue' || s.kind === 'missed' ? 'pending' : ''), role: 'button', tabindex: 0, onclick: () => openBillForm(b, mk) },
      ck,
      el('div', { style: 'min-width:0' }, el('div', { class: 'payee' }, b.name, b.item ? el('span', { class: 'muted' }, ' · ' + b.item) : b.category === BNPL ? el('span', { class: 'warnc' }, ' · add what it’s for') : null), el('div', { class: 'sub' }, meta.join(' · '))),
      el('div', { class: 'amt ' + (!paid && !b.amount_cents ? 'muted' : '') }, fmt(paid ? s.p.amount_cents : b.amount_cents)));
  }

  // Mark paid: confirm the amount, then it posts to the register automatically
  function openPaySheet(b, mk) {
    const amount = el('input', { class: 'input amount-input', inputmode: 'decimal', value: (b.amount_cents / 100).toFixed(2) });
    const acctName = (state.accounts.find(a => a.id === V.data.link_account) || {}).name || 'your account';
    const sheet = openSheet(`Pay ${b.name}${b.item ? ' · ' + b.item : ''}`,
      el('p', { class: 'muted small' }, `${monthLabel(mk)} · due the ${ord(b.due)}. ${b.amount_cents ? `This also adds a payment to ${acctName} in the register.` : 'Nothing due this month — marking it paid just checks it off; a $0 payment adds nothing to the register.'}`),
      el('label', { class: 'field' }, el('span', {}, 'Amount paid'), amount),
      el('button', { class: 'btn primary block', onclick: async () => {
        const c = Math.round(parseFloat(String(amount.value).replace(/[^0-9.]/g, '')) * 100);
        if (!Number.isFinite(c)) { amount.focus(); return; }
        try { await api('/bills/pay', { method: 'POST', body: { month: mk, bill_id: b.id, payment: { amount_cents: c } } }); sheet.close(); toast(c ? `${b.name} marked paid · added to register` : `${b.name} marked paid ($0, nothing added to register)`, 3000); viewBills(); }
        catch (ex) { toast(ex.message, 4000); }
      } }, 'Mark paid'));
    setTimeout(() => amount.select(), 80);
  }

  // ---------------- add / edit ----------------
  const TEMPLATES = [['Affirm plan', 'Affirm', BNPL], ['Klarna plan', 'Klarna', BNPL], ['Credit card', '', 'Credit card'], ['Utility', '', 'Utilities', 'Household'], ['Subscription', '', 'Subscription', 'Household', true], ['Loan', '', 'Loan'], ['Other', '', 'Other']];
  function openBillForm(b, mk) {
    const isNew = !b; b = b || { name: '', item: '', who: state.user.display_name, category: 'Other', due: '', autopay: 'No', amount_cents: 0, ends: '', balance_cents: null, status: 'Active', note: '' };
    const people = ['Household', ...(V.data.users || [])];
    const name = autoCap(el('input', { class: 'input', placeholder: 'Chase card, Electric…', value: b.name, autocomplete: 'off' }));
    const item = el('input', { class: 'input', placeholder: 'Couch, PS5, tires…', value: b.item, autocomplete: 'off' });
    const amount = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: '0.00', value: b.amount_cents ? (b.amount_cents / 100).toFixed(2) : '' });
    const due = el('input', { class: 'input', inputmode: 'numeric', placeholder: '1–31', value: b.due || '' });
    const cat = el('select', { class: 'input' }, ...V.data.cats.map(c => el('option', { value: c, selected: c === b.category }, c === BNPL ? 'Affirm / Klarna (Buy Now Pay Later)' : c)));
    const who = el('select', { class: 'input' }, ...people.map(p => el('option', { value: p, selected: p === b.who }, p)));
    const auto = el('input', { type: 'checkbox', checked: b.autopay === 'Yes' });
    const ends = el('input', { class: 'input', type: 'month', value: b.ends || '' });
    const bal = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Optional', value: b.balance_cents == null ? '' : (b.balance_cents / 100).toFixed(2) });
    const status = el('select', { class: 'input' }, ...['Active', 'Paid off', 'Paused'].map(s => el('option', { value: s, selected: s === b.status }, s)));
    const note = el('input', { class: 'input', value: b.note, autocomplete: 'off' });
    const err = el('div', { class: 'err' });
    const bnplFields = el('div', { class: 'grid2', hidden: b.category !== BNPL && !b.item && !b.ends }, el('label', { class: 'field' }, el('span', {}, 'Last payment month'), ends), el('label', { class: 'field' }, el('span', {}, 'Balance left'), bal));
    cat.onchange = () => { bnplFields.hidden = cat.value !== BNPL && !item.value && !ends.value; };
    const tmpl = isNew ? el('div', { class: 'chips', style: 'margin-bottom:12px' }, ...TEMPLATES.map(([label, nm, c, w, ap]) => el('button', { class: 'chip', type: 'button', onclick: () => { if (nm) name.value = nm; cat.value = c; if (w) who.value = w; auto.checked = !!ap; cat.onchange(); (nm ? amount : name).focus(); } }, label))) : null;
    const pay = !isNew && mk ? payOf(mk, b.id) : null;
    const sheet = openSheet(isNew ? 'Add a bill' : 'Edit bill',
      tmpl,
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      el('label', { class: 'field' }, el('span', {}, 'What it’s for (optional)'), item),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Monthly amount'), amount), el('label', { class: 'field' }, el('span', {}, 'Due day'), due)),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Category'), cat), el('label', { class: 'field' }, el('span', {}, 'Whose'), who)),
      bnplFields,
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Status'), status), el('label', { class: 'field' }, el('span', {}, 'Note'), note)),
      el('label', { class: 'row small', style: 'margin-bottom:12px' }, auto, ' Autopay — marks itself paid on the due day and posts to the register'),
      pay ? el('p', { class: 'muted small' }, `Paid ${fmt(pay.amount_cents)} in ${monthLabel(mk)}${pay.by ? ' by ' + pay.by : ''}. Tap the circle on the list to unmark it.`) : null,
      err,
      isNew ? null : el('div', { class: 'card', style: 'padding:12px 14px' },
        el('div', { class: 'small', style: 'margin-bottom:8px' }, isActive(b) ? 'Done with this bill? Mark it paid off: it leaves the monthly schedule and totals but keeps its history until you delete it.' : `This bill is ${b.status.toLowerCase()} and off the schedule.`),
        el('div', { class: 'btnrow' },
          isActive(b)
            ? [el('button', { class: 'btn', onclick: () => setStatus('Paid off') }, '✓ Paid off'), el('button', { class: 'btn', onclick: () => setStatus('Paused') }, 'Pause')]
            : el('button', { class: 'btn primary', onclick: () => setStatus('Active') }, 'Put back on the schedule'))),
      el('div', { class: 'btnrow' },
        isNew ? null : el('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete ${b.name}? Its payment history goes too.`)) return; await api(`/bills/${b.id}`, { method: 'DELETE' }); sheet.close(); toast('Deleted'); viewBills(); } }, 'Delete'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          const body = { name: titleCase(name.value), item: item.value.trim(), amount: amount.value, due: due.value, category: cat.value, who: who.value, autopay: auto.checked ? 'Yes' : 'No', ends: ends.value, balance: bal.value.trim() === '' ? null : bal.value, status: status.value, note: note.value };
          try { if (isNew) await api('/bills', { method: 'POST', body }); else await api(`/bills/${b.id}`, { method: 'PATCH', body }); sheet.close(); toast('Saved'); viewBills(); }
          catch (ex) { err.textContent = ex.message; }
        } }, isNew ? 'Add bill' : 'Save')));
    async function setStatus(st) {
      try { await api(`/bills/${b.id}`, { method: 'PATCH', body: { status: st } }); sheet.close(); toast(st === 'Active' ? `${b.name} is back on the schedule` : `${b.name} marked ${st.toLowerCase()}`); viewBills(); }
      catch (ex) { err.textContent = ex.message; }
    }
    setTimeout(() => (isNew ? name : amount).focus(), 80);
  }

  // ---------------- Affirm / Klarna plans ----------------
  function renderPlans(all, N) {
    const plans = all.filter(b => b.category === BNPL), act = plans.filter(isActive), done = plans.filter(b => !isActive(b));
    const withEnd = act.filter(b => b.ends);
    const owed = withEnd.reduce((s, b) => s + (b.balance_cents != null ? b.balance_cents : (paymentsLeft(b) || 0) * b.amount_cents), 0);
    const ending = withEnd.filter(b => (paymentsLeft(b) || 0) <= 3);
    const summary = el('div', { class: 'card' },
      el('div', { class: 'stats' },
        el('div', {}, el('div', { class: 'muted small' }, 'Plans'), el('div', { class: 'stat' }, act.length)),
        el('div', {}, el('div', { class: 'muted small' }, 'Per month'), el('div', { class: 'stat' }, fmt(act.reduce((s, b) => s + b.amount_cents, 0)))),
        el('div', {}, el('div', { class: 'muted small' }, 'Need details'), el('div', { class: 'stat ' + (act.filter(needsDetails).length ? 'warnc' : '') }, act.filter(needsDetails).length))),
      el('div', { class: 'row small', style: 'margin-top:10px' }, el('span', { class: 'grow muted' }, 'Left to pay (plans with an end date)'), el('b', { class: 'mono' }, withEnd.length ? `${fmt(owed)} · ${withEnd.length} of ${act.length}` : 'Add end dates')),
      el('div', { class: 'row small' }, el('span', { class: 'grow muted' }, 'Ending in the next 3 months'), el('b', {}, ending.length ? `${ending.length} · frees ${fmt(ending.reduce((s, b) => s + b.amount_cents, 0))}/mo` : '—')),
      el('p', { class: 'muted small', style: 'margin:10px 0 0' }, 'Open the Affirm or Klarna app, find each plan by its monthly amount, and fill in what it was for and the month of its last payment.'));
    const sorted = act.slice().sort((a, b) => (needsDetails(b) - needsDetails(a)) || ((a.ends || '9999') < (b.ends || '9999') ? -1 : (a.ends || '9999') > (b.ends || '9999') ? 1 : a.due - b.due));
    const list = el('div', {}, ...(sorted.length ? sorted.map(planCard) : [el('div', { class: 'empty' }, 'No active Affirm or Klarna plans.')]));
    const doneBox = done.length ? el('details', { style: 'margin-top:14px' }, el('summary', { class: 'muted small' }, `Paid off (${done.length})`), ...done.map(b => el('div', { class: 'row small', style: 'padding:8px 4px' }, el('span', { class: 'grow' }, `${b.name}${b.item ? ' · ' + b.item : ''} · ${fmt(b.amount_cents)}`), el('button', { class: 'btn small', onclick: async () => { await api(`/bills/${b.id}`, { method: 'PATCH', body: { status: 'Active' } }); viewBills(); } }, 'Undo')))) : null;
    return el('div', {}, summary, list, doneBox);
  }
  function planCard(b) {
    const item = el('input', { class: 'input', placeholder: 'What it was for', value: b.item, autocomplete: 'off' });
    const ends = el('input', { class: 'input', type: 'month', value: b.ends || '' });
    const bal = el('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Optional', value: b.balance_cents == null ? '' : (b.balance_cents / 100).toFixed(2) });
    const save = el('button', { class: 'btn small primary', hidden: true, onclick: async () => {
      try { await api(`/bills/${b.id}`, { method: 'PATCH', body: { item: item.value.trim(), ends: ends.value, balance: bal.value.trim() === '' ? null : bal.value } }); toast('Saved'); viewBills(); } catch (ex) { toast(ex.message, 4000); }
    } }, 'Save');
    const dirty = () => { save.hidden = !(item.value.trim() !== (b.item || '') || ends.value !== (b.ends || '') || bal.value.trim() !== (b.balance_cents == null ? '' : (b.balance_cents / 100).toFixed(2))); };
    [item, ends, bal].forEach(i => { i.oninput = dirty; i.onchange = dirty; });
    const pl = paymentsLeft(b);
    const meta = [`Due ${ord(b.due)}`]; if (b.who !== 'Household') meta.push(b.who); if (payOf(curKey(), b.id)) meta.push('Paid ' + MON[now().getMonth()]);
    return el('div', { class: 'card' + (needsDetails(b) ? ' needs' : '') },
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('b', {}, b.name + (b.item ? ' · ' + b.item : '')), el('div', { class: 'muted small' }, meta.join(' · '))), el('b', { class: 'mono' }, fmt(b.amount_cents) + '/mo')),
      el('div', { class: 'grid2', style: 'margin-top:10px' }, el('label', { class: 'field' }, el('span', {}, 'What it’s for'), item), el('label', { class: 'field' }, el('span', {}, 'Last payment'), ends)),
      el('div', { class: 'row' }, el('label', { class: 'field grow', style: 'margin:0' }, el('span', {}, 'Balance left'), bal)),
      el('div', { class: 'row small', style: 'margin-top:10px' },
        el('span', { class: 'grow muted' }, b.ends ? (pl === 0 ? 'Last payment was ' + monthLabel(b.ends) : `${pl} payment${pl === 1 ? '' : 's'} left · last one ${monthLabel(b.ends)}`) : 'Add the last payment month to see payments left'),
        save,
        el('button', { class: 'btn small' + (pl === 0 && b.ends ? ' primary' : ''), onclick: async () => { await api(`/bills/${b.id}`, { method: 'PATCH', body: { status: 'Paid off' } }); toast(`${b.name} marked paid off`); viewBills(); } }, 'Paid off')));
  }

  window.CB.views.bills = viewBills;
})();

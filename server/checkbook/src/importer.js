// Parsers and normalizers for importing other checkbook apps' exports.

function parseCSV(text) {
  // RFC 4180-ish parser: handles quotes, escaped quotes, CRLF, and
  // auto-detects comma / semicolon / tab delimiters.
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(f => f.trim() !== '')) rows.push(row); }
  return rows;
}

// Header aliases → canonical field names
const FIELD_ALIASES = {
  date: ['date', 'transaction date', 'trans date', 'posted', 'post date', 'posting date', 'time'],
  account: ['account', 'account name', 'acct'],
  payee: ['payee', 'description', 'name', 'merchant', 'to/from', 'transaction', 'details', 'desc'],
  category: ['category', 'cat', 'tag'],
  type: ['type', 'transaction type', 'trans type', 'kind', 'in/out', 'dr/cr'],
  memo: ['memo', 'note', 'notes', 'comment', 'comments', 'remark', 'remarks'],
  amount: ['amount', 'amt', 'value', 'total', 'sum'],
  deposit: ['deposit', 'deposits', 'credit', 'credits', 'income', 'inflow', 'in', 'payment in', 'money in'],
  withdrawal: ['withdrawal', 'withdrawals', 'debit', 'debits', 'expense', 'expenses', 'outflow', 'out', 'payment', 'payment out', 'money out', 'charge'],
  check_no: ['check', 'check no', 'check #', 'check number', 'chk', 'cheque', 'cheque no', 'number', 'num', 'ref', 'reference'],
  status: ['status', 'cleared', 'reconciled', 'clear', 'c', 'r', 'state', 'checked'],
  balance: ['balance', 'running balance', 'bal']
};

function detectMapping(headers) {
  const mapping = {};
  const used = new Set();
  const norm = h => h.toLowerCase().replace(/[^a-z0-9#/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // exact matches first, then "contains"
  for (const pass of ['exact', 'contains']) {
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[field] !== undefined) continue;
      for (let i = 0; i < headers.length; i++) {
        if (used.has(i)) continue;
        const h = norm(headers[i]);
        const hit = pass === 'exact' ? aliases.includes(h) : aliases.some(a => a.length > 2 && h.includes(a));
        if (hit) { mapping[field] = i; used.add(i); break; }
      }
    }
  }
  return mapping;
}

function parseAmount(s) {
  if (s === undefined || s === null) return null;
  s = String(s).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (/^\+/.test(s)) s = s.slice(1);
  if (/\b(dr|debit)\b/i.test(s)) neg = true;
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;
  // Decide decimal separator: last of '.' or ','
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return neg ? -cents : cents;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function parseDate(s, dayFirst = false) {
  if (!s) return null;
  s = String(s).trim();
  let m;
  const pad = n => String(n).padStart(2, '0');
  const mk = (y, mo, d) => {
    y = Number(y); mo = Number(mo); d = Number(d);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  };
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return mk(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    let a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) return mk(m[3], b, a);
    if (b > 12 && a <= 12) return mk(m[3], a, b);
    return dayFirst ? mk(m[3], b, a) : mk(m[3], a, b);
  }
  if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{2,4})/i))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return mk(m[3], mo, m[1]);
  }
  if ((m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{2,4})/i))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return mk(m[3], mo, m[2]);
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return mk(m[1], m[2], m[3]);
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return null;
}

function parseStatus(s) {
  if (!s) return '';
  s = String(s).trim().toLowerCase();
  if (['r', 'reconciled', 'x', 'yes r'].includes(s)) return 'reconciled';
  if (['c', 'cleared', 'clear', 'yes', 'y', 'true', '1', '*', 'checked', 'posted'].includes(s)) return 'cleared';
  return '';
}

// Turn CSV rows + mapping into normalized transactions
function normalizeRows(rows, mapping, opts = {}) {
  const { hasHeader = true, dayFirst = false, invertAmounts = false } = opts;
  const data = hasHeader ? rows.slice(1) : rows;
  const out = [], errors = [];
  const get = (r, f) => (mapping[f] === undefined || mapping[f] === null || mapping[f] === '' ? '' : (r[mapping[f]] ?? '').toString().trim());
  data.forEach((r, idx) => {
    const line = idx + (hasHeader ? 2 : 1);
    const date = parseDate(get(r, 'date'), dayFirst);
    if (!date) { errors.push({ line, error: 'Unreadable date', row: r }); return; }
    let amount = null;
    if (mapping.amount !== undefined && mapping.amount !== '') amount = parseAmount(get(r, 'amount'));
    if (amount === null) {
      const dep = parseAmount(get(r, 'deposit')), wd = parseAmount(get(r, 'withdrawal'));
      if (dep !== null || wd !== null) amount = Math.abs(dep || 0) - Math.abs(wd || 0);
    }
    if (amount === null) { errors.push({ line, error: 'No amount', row: r }); return; }
    // A separate Type column ("Expense"/"Income", "Debit"/"Credit") fixes the sign when amounts are unsigned
    const ty = get(r, 'type').toLowerCase();
    if (ty) {
      if (amount > 0 && /withdraw|debit|payment|expense|check|cheque|spend|^out$|^dr$|^w$/.test(ty)) amount = -amount;
      else if (amount < 0 && /deposit|credit|income|^cr$|^in$/.test(ty)) amount = -amount;
    }
    if (invertAmounts) amount = -amount;
    out.push({
      line,
      date,
      account: get(r, 'account'),
      payee: get(r, 'payee'),
      category: get(r, 'category'),
      memo: get(r, 'memo'),
      amount,
      check_no: get(r, 'check_no'),
      status: parseStatus(get(r, 'status'))
    });
  });
  return { transactions: out, errors };
}

// QIF parser (Quicken Interchange Format). Returns normalized transactions.
function parseQIF(text) {
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const out = [], errors = [];
  let cur = {}, account = '', inAccountBlock = false, lineNo = 0, startLine = 1;
  const flush = () => {
    if (cur.date || cur.amount !== undefined) {
      const date = parseDate(cur.date || '');
      if (!date) errors.push({ line: startLine, error: 'Unreadable date', row: [cur.date] });
      else out.push({
        line: startLine, date, account,
        payee: cur.payee || '', category: cur.category || '', memo: cur.memo || '',
        amount: cur.amount ?? 0, check_no: cur.check_no || '', status: parseStatus(cur.status)
      });
    }
    cur = {}; startLine = lineNo + 1;
  };
  for (const raw of lines) {
    lineNo++;
    if (!raw.trim()) continue;
    const code = raw[0], val = raw.slice(1).trim();
    if (code === '!') {
      flush();
      inAccountBlock = /^Account/i.test(val);
      continue;
    }
    if (inAccountBlock) {
      if (code === 'N') account = val;
      if (code === '^') inAccountBlock = false;
      continue;
    }
    switch (code) {
      case 'D': cur.date = val; break;
      case 'T': case 'U': cur.amount = parseAmount(val) ?? 0; break;
      case 'P': cur.payee = val; break;
      case 'M': cur.memo = val; break;
      case 'L': cur.category = val.replace(/^\[(.*)\]$/, 'Transfer: $1'); break;
      case 'N': cur.check_no = val; break;
      case 'C': cur.status = val; break;
      case '^': flush(); break;
      default: break;
    }
  }
  flush();
  return { transactions: out, errors };
}

module.exports = { parseCSV, detectMapping, normalizeRows, parseQIF, parseAmount, parseDate, FIELD_ALIASES };

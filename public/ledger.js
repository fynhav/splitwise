/*
 * Ledger: money, currency conversion, splits and settlement.
 * Shared by the server (require) and the browser (window.Ledger).
 * All money is held as integer minor units (pence, cents). No floats in balances.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'UGX', 'XAF', 'XOF', 'XPF', 'RWF', 'KMF', 'DJF', 'GNF', 'BIF', 'VUV']);
  const THREE_DEC = new Set(['BHD', 'KWD', 'JOD', 'OMR', 'TND', 'IQD', 'LYD']);

  function exponent(cur) {
    return ZERO_DEC.has(cur) ? 0 : THREE_DEC.has(cur) ? 3 : 2;
  }

  /** Parse a user-typed amount ("12.5", "12,50", "1,234.56") to integer minor units, or null. */
  function parseAmount(input, cur) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return null;
      input = String(input);
    }
    if (typeof input !== 'string') return null;
    let s = input.trim().replace(/[\s_']/g, '');
    if (s.includes(',') && s.includes('.')) {
      // whichever separator comes last is the decimal point: "1,234.56" or "1.234,56"
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.includes(',')) {
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length !== 3) s = parts[0] + '.' + parts[1];
      else s = s.replace(/,/g, '');
    }
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    const e = exponent(cur);
    const parts = s.split('.');
    const whole = parts[0] || '0';
    const frac = (parts[1] || '').padEnd(e + 1, '0');
    const keep = e ? Number(frac.slice(0, e)) : 0;
    const next = frac.charCodeAt(e) - 48;
    let minor = Number(whole) * Math.pow(10, e) + keep;
    if (next >= 5) minor += 1; // round half up on the string, so no float error
    return Number.isSafeInteger(minor) ? minor : null;
  }

  /** Integer minor units to a plain editable string, e.g. 1250 -> "12.50". */
  function minorToInput(minor, cur) {
    const e = exponent(cur);
    return (minor / Math.pow(10, e)).toFixed(e);
  }

  function formatMinor(minor, cur, locale) {
    const e = exponent(cur);
    const v = minor / Math.pow(10, e);
    try {
      return new Intl.NumberFormat(locale || 'en-GB', {
        style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: e, maximumFractionDigits: e,
      }).format(v);
    } catch (err) {
      return v.toFixed(e) + ' ' + cur;
    }
  }

  /** Convert minor units of `from` into minor units of `to`; rate = units of `to` per 1 unit of `from`. */
  function convertMinor(minor, from, to, rate) {
    if (from === to) return minor;
    const v = (minor / Math.pow(10, exponent(from))) * rate * Math.pow(10, exponent(to));
    return Math.round(Number(v.toFixed(6)));
  }

  /** Effective rate (base per 1 foreign) implied by an actual amount charged. */
  function effectiveRate(origMinor, origCur, baseMinor, baseCur) {
    return (baseMinor / Math.pow(10, exponent(baseCur))) / (origMinor / Math.pow(10, exponent(origCur)));
  }

  /**
   * table = { base: 'GBP', rates: { USD: 1.31, ... } } where rates are per 1 base.
   * Returns base per 1 `cur`, or null if unknown.
   */
  function rateToBase(table, cur) {
    if (!table || !table.rates) return null;
    if (cur === table.base) return 1;
    const r = table.rates[cur];
    return r > 0 ? 1 / r : null;
  }

  /**
   * Split `total` (integer) across positive integer weights using largest remainder. Sum is always exact.
   * Ties for a leftover penny go to the person at position `start` first, then the next, so callers can rotate it.
   */
  function allocate(total, weights, start) {
    if (!Number.isInteger(total) || total < 0) throw new Error('total must be a non-negative integer');
    if (!weights.length) throw new Error('no weights');
    let W = 0;
    for (const w of weights) {
      if (!Number.isInteger(w) || w <= 0) throw new Error('weights must be positive integers');
      W += w;
    }
    const out = [];
    const rems = [];
    let used = 0;
    weights.forEach((w, i) => {
      const prod = total * w;
      const q = Math.floor(prod / W);
      out.push(q);
      rems.push({ i, r: prod - q * W });
      used += q;
    });
    const n = weights.length;
    const s0 = ((start || 0) % n + n) % n;
    const turn = (i) => (i - s0 + n) % n;
    rems.sort((a, b) => b.r - a.r || turn(a.i) - turn(b.i));
    for (let k = 0; k < total - used; k++) out[rems[k].i] += 1;
    return out;
  }

  function orderOf(state) {
    return state.people.map((p) => p.id);
  }

  /** A stable number from an expense id, so leftover pennies rotate between people instead of always landing on the same one. */
  function pennyTurn(id) {
    let h = 0;
    for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  }

  /** What each person owes for one expense (base minor units). */
  function sharesOf(exp, order) {
    const ids = order.filter((id) => exp.split.weights[id] > 0);
    const alloc = allocate(exp.baseMinor, ids.map((id) => exp.split.weights[id]), pennyTurn(exp.id));
    const out = {};
    ids.forEach((id, i) => { out[id] = alloc[i]; });
    return out;
  }

  /** Who gets credit for paying: the card's holders, equally. */
  function creditsOf(exp, card, order) {
    const holders = order.filter((id) => card.holders.includes(id));
    const alloc = allocate(exp.baseMinor, holders.map(() => 1), pennyTurn(exp.id));
    const out = {};
    holders.forEach((id, i) => { out[id] = alloc[i]; });
    return out;
  }

  const live = (x) => !x.deletedAt;

  /** Per-person paid / owed / sent / received / net. net > 0 means the person is owed money. */
  function computeBalances(state) {
    const order = orderOf(state);
    const cards = Object.fromEntries(state.cards.map((c) => [c.id, c]));
    const b = Object.fromEntries(order.map((id) => [id, { paid: 0, owed: 0, sent: 0, received: 0, net: 0 }]));
    for (const e of state.expenses.filter(live)) {
      const owed = sharesOf(e, order);
      for (const id in owed) b[id].owed += owed[id];
      const card = cards[e.cardId];
      if (!card) throw new Error('expense ' + e.id + ' references missing card ' + e.cardId);
      const cr = creditsOf(e, card, order);
      for (const id in cr) b[id].paid += cr[id];
    }
    for (const s of state.settlements.filter(live)) {
      b[s.from].sent += s.baseMinor;
      b[s.to].received += s.baseMinor;
    }
    for (const id of order) b[id].net = b[id].paid - b[id].owed + b[id].sent - b[id].received;
    return b;
  }

  /** Settlement units: households merge into one unit when enabled; everyone else is alone. */
  function unitsOf(state) {
    const order = orderOf(state);
    const seen = new Set();
    const units = [];
    const groups = state.settings && state.settings.householdsOn ? state.households || [] : [];
    for (const id of order) {
      if (seen.has(id)) continue;
      const group = groups.find((g) => g.includes(id));
      const members = group ? order.filter((x) => group.includes(x) && !seen.has(x)) : [id];
      members.forEach((m) => seen.add(m));
      units.push(members);
    }
    return units;
  }

  /** Net balances per unit and a greedy set of transfers that clears them. */
  function settlementPlan(state) {
    const balances = computeBalances(state);
    const units = unitsOf(state).map((members) => ({
      members,
      net: members.reduce((s, id) => s + balances[id].net, 0),
    }));
    const debtors = units.map((u, i) => ({ u, i, amt: -u.net })).filter((x) => x.amt > 0)
      .sort((a, b) => b.amt - a.amt || a.i - b.i);
    const creditors = units.map((u, i) => ({ u, i, amt: u.net })).filter((x) => x.amt > 0)
      .sort((a, b) => b.amt - a.amt || a.i - b.i);
    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const x = Math.min(debtors[i].amt, creditors[j].amt);
      transfers.push({ from: debtors[i].u.members, to: creditors[j].u.members, baseMinor: x });
      debtors[i].amt -= x;
      creditors[j].amt -= x;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    return { balances, units, transfers };
  }

  function spendByCard(state) {
    const out = Object.fromEntries(state.cards.map((c) => [c.id, 0]));
    for (const e of state.expenses.filter(live)) out[e.cardId] = (out[e.cardId] || 0) + e.baseMinor;
    return out;
  }

  function totalSpent(state) {
    return state.expenses.filter(live).reduce((s, e) => s + e.baseMinor, 0);
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  return {
    exponent, parseAmount, minorToInput, formatMinor, convertMinor, effectiveRate, rateToBase,
    allocate, sharesOf, creditsOf, computeBalances, unitsOf, settlementPlan, spendByCard, totalSpent, today,
  };
});

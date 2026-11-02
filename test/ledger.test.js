'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/ledger.js');

const people = ['fynn', 'tara', 'max'].map((id) => ({ id, name: id }));
const cards = [
  { id: 'shared', name: 'Shared', holders: ['fynn', 'tara'] },
  { id: 'fynn', name: "Fynn's", holders: ['fynn'] },
  { id: 'tara', name: "Tara's", holders: ['tara'] },
  { id: 'max', name: "Max's", holders: ['max'] },
];
let n = 0;
const exp = (cardId, baseMinor, who = ['fynn', 'tara', 'max']) => ({
  id: 'e' + ++n, cardId, baseMinor, currency: 'GBP', amountMinor: baseMinor,
  split: { weights: Object.fromEntries(who.map((w) => [w, 1])) },
});
const mk = (expenses, over = {}) => ({
  people, cards, expenses, settlements: [], households: [['fynn', 'tara']],
  settings: { baseCurrency: 'GBP', householdsOn: true }, ...over,
});

test('parseAmount handles common inputs and rejects junk', () => {
  assert.equal(L.parseAmount('12.5', 'GBP'), 1250);
  assert.equal(L.parseAmount('12,50', 'GBP'), 1250);
  assert.equal(L.parseAmount('1,234.56', 'GBP'), 123456);
  assert.equal(L.parseAmount('1.005', 'GBP'), 101);
  assert.equal(L.parseAmount('.5', 'GBP'), 50);
  assert.equal(L.parseAmount('1000', 'JPY'), 1000);
  assert.equal(L.parseAmount('1.234', 'KWD'), 1234);
  assert.equal(L.parseAmount(96, 'USD'), 9600);
  for (const bad of ['', 'abc', '-5', '1.2.3', null, undefined, NaN]) assert.equal(L.parseAmount(bad, 'GBP'), null, String(bad));
});

test('convertMinor and effectiveRate', () => {
  assert.equal(L.convertMinor(1000, 'USD', 'GBP', 0.76), 760);
  assert.equal(L.convertMinor(10000, 'JPY', 'GBP', 0.0052), 5200);
  assert.equal(L.convertMinor(5200, 'GBP', 'JPY', 1 / 0.0052), 10000);
  assert.equal(L.convertMinor(1234, 'GBP', 'GBP', 99), 1234);
  assert.ok(Math.abs(L.effectiveRate(9600, 'USD', 7300, 'GBP') - 73 / 96) < 1e-12);
  assert.equal(L.rateToBase({ base: 'GBP', rates: { USD: 2 } }, 'USD'), 0.5);
  assert.equal(L.rateToBase({ base: 'GBP', rates: {} }, 'GBP'), 1);
  assert.equal(L.rateToBase({ base: 'GBP', rates: {} }, 'EUR'), null);
});

test('allocate: exact sum and fair remainders', () => {
  assert.deepEqual(L.allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(L.allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(L.allocate(5, [1, 1]), [3, 2]);
  assert.deepEqual(L.allocate(0, [1, 2]), [0, 0]);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 2000; k++) {
    const total = Math.floor(rnd() * 1e7);
    const w = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => 1 + Math.floor(rnd() * 9));
    const W = w.reduce((a, b) => a + b, 0);
    const out = L.allocate(total, w);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
    out.forEach((v, i) => assert.ok(Math.abs(v - (total * w[i]) / W) < 1, 'within one minor unit'));
  }
  assert.throws(() => L.allocate(10, [0, 1]));
  assert.throws(() => L.allocate(10, []));
});

test('original scenario: shared card + Max own card, households settle as one', () => {
  const s = mk([exp('shared', 54000), exp('max', 36000), exp('shared', 9600), exp('max', 21000)]);
  const plan = L.settlementPlan(s);
  assert.equal(L.totalSpent(s), 120600);
  assert.deepEqual(plan.transfers, [{ from: ['fynn', 'tara'], to: ['max'], baseMinor: 16800 }]);
  assert.equal(plan.balances.max.net, 16800);
  assert.equal(plan.balances.fynn.net + plan.balances.tara.net, -16800);
});

test('individual mode splits the household debt', () => {
  const s = mk([exp('shared', 54000), exp('max', 36000), exp('shared', 9600), exp('max', 21000)], {
    settings: { baseCurrency: 'GBP', householdsOn: false },
  });
  const plan = L.settlementPlan(s);
  assert.deepEqual(plan.transfers.map((t) => [t.from[0], t.to[0], t.baseMinor]), [['fynn', 'max', 8400], ['tara', 'max', 8400]]);
});

test('own cards for Fynn and Tara mixed with shared card', () => {
  // Fynn card 300, Tara card 60, shared 90, Max 120, all split 3 ways (total 570, 190 each)
  const s = mk([exp('fynn', 30000), exp('tara', 6000), exp('shared', 9000), exp('max', 12000)]);
  const b = L.computeBalances(s);
  assert.equal(b.fynn.paid, 30000 + 4500);
  assert.equal(b.tara.paid, 6000 + 4500);
  assert.equal(b.max.paid, 12000);
  assert.equal(b.fynn.owed, 19000);
  assert.equal(b.fynn.net, 34500 - 19000);
  assert.equal(b.tara.net, 10500 - 19000);
  assert.equal(b.max.net, 12000 - 19000);
  const plan = L.settlementPlan(s);
  // household net = (15500 - 8500) = +7000, Max = -7000 -> Max pays Fynn + Tara
  assert.deepEqual(plan.transfers, [{ from: ['max'], to: ['fynn', 'tara'], baseMinor: 7000 }]);
});

test('weights (shares) split correctly', () => {
  const e = { ...exp('max', 10000), split: { weights: { fynn: 2, tara: 2, max: 1 } } };
  assert.deepEqual(L.sharesOf(e, ['fynn', 'tara', 'max']), { fynn: 4000, tara: 4000, max: 2000 });
});

test('property: nets sum to zero and applying the plan clears everything', () => {
  let seed = 987;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const cardIds = cards.map((c) => c.id);
  for (let k = 0; k < 300; k++) {
    const expenses = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => {
      const who = people.map((p) => p.id).filter(() => rnd() > 0.3);
      return exp(cardIds[Math.floor(rnd() * cardIds.length)], 1 + Math.floor(rnd() * 100000), who.length ? who : ['max']);
    });
    for (const householdsOn of [true, false]) {
      const s = mk(expenses, { settings: { baseCurrency: 'GBP', householdsOn } });
      const plan = L.settlementPlan(s);
      const sum = Object.values(plan.balances).reduce((a, x) => a + x.net, 0);
      assert.equal(sum, 0, 'nets must sum to zero');
      const settlements = plan.transfers.map((t, i) => ({ id: 's' + i, from: t.from[0], to: t.to[0], baseMinor: t.baseMinor }));
      const after = L.settlementPlan({ ...s, settlements });
      assert.equal(after.transfers.length, 0, 'plan should clear all balances');
      after.units.forEach((u) => assert.equal(u.net, 0));
    }
  }
});

test('deleted expenses and settlements are ignored', () => {
  const s = mk([{ ...exp('max', 30000), deletedAt: 'x' }, exp('max', 3000)]);
  assert.equal(L.totalSpent(s), 3000);
  assert.equal(L.computeBalances(s).max.paid, 3000);
});

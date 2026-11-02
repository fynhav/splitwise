'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');
const { createRates, normalize } = require('../lib/rates.js');
const L = require('../public/ledger.js');

// 1 GBP = 1.25 USD, 150 JPY
const stubRates = {
  async get(base) {
    return { base, date: '2026-11-02', fetchedAt: Date.now(), stale: false, rates: { GBP: 1, USD: 1.25, PAB: 1.25, JPY: 150 } };
  },
};

async function boot(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'trip-'));
  const app = createApp({ dataDir, pin: '', ratesProvider: stubRates, ...extra });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.server.unref(); // a failing assertion must never leave the test process hanging
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { app, base, call, dataDir, close: () => app.close() };
}

const ex = (over = {}) => ({
  title: 'Dinner', amount: '60', currency: 'GBP', cardId: 'shared', split: { among: ['fynn', 'tara', 'max'] }, ...over,
});

test('seeded state defaults to GBP with shared and own cards', async () => {
  const t = await boot();
  const { data } = await t.call('GET', '/api/state');
  assert.equal(data.settings.baseCurrency, 'GBP');
  assert.deepEqual(data.people.map((p) => p.id), ['fynn', 'tara', 'max']);
  assert.deepEqual(data.cards.map((c) => c.id), ['shared', 'fynn-own', 'tara-own', 'max-own']);
  assert.deepEqual(data.cards.find((c) => c.id === 'shared').holders, ['fynn', 'tara']);
  await t.close();
});

test('currency conversion: auto rate, manual rate, actual charge, and errors', async () => {
  const t = await boot();
  let r = await t.call('POST', '/api/expenses', ex({ amount: '96', currency: 'USD' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.expense.baseMinor, 7680); // 96 / 1.25
  assert.equal(r.data.expense.rateSource, 'auto');
  assert.equal(r.data.expense.amountMinor, 9600);

  r = await t.call('POST', '/api/expenses', ex({ amount: '96', currency: 'USD', rate: 0.77, rateSource: 'manual' }));
  assert.equal(r.data.expense.baseMinor, 7392);
  assert.equal(r.data.expense.rateSource, 'manual');

  r = await t.call('POST', '/api/expenses', ex({ amount: '96', currency: 'USD', actualBase: '75.00' }));
  assert.equal(r.data.expense.baseMinor, 7500);
  assert.equal(r.data.expense.rateSource, 'actual');
  assert.ok(Math.abs(r.data.expense.rate - 0.78125) < 1e-9);

  r = await t.call('POST', '/api/expenses', ex({ amount: '10000', currency: 'JPY' }));
  assert.equal(r.data.expense.baseMinor, 6667); // 10000 / 150 = 66.666...

  r = await t.call('POST', '/api/expenses', ex({ amount: '5', currency: 'PAB' }));
  assert.equal(r.data.expense.baseMinor, 400); // balboa pegged to USD via provider

  r = await t.call('POST', '/api/expenses', ex({ amount: '5', currency: 'XYZ' }));
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'no_rate');
  await t.close();
});

test('validation rejects bad input', async () => {
  const t = await boot();
  const cases = [
    ex({ title: '' }), ex({ amount: '0' }), ex({ amount: 'abc' }), ex({ cardId: 'nope' }),
    ex({ split: { among: ['ghost'] } }), ex({ split: { weights: { fynn: 0 } } }), ex({ split: { weights: { fynn: 1.5 } } }),
    ex({ currency: 'DOLLARS' }),
  ];
  for (const c of cases) {
    const r = await t.call('POST', '/api/expenses', c);
    assert.equal(r.status, 400, JSON.stringify(c));
  }
  assert.equal((await t.call('GET', '/api/state')).data.expenses.length, 0);
  await t.close();
});

test('own cards for Fynn and Tara settle correctly end to end', async () => {
  const t = await boot();
  await t.call('POST', '/api/expenses', ex({ title: 'Hotel', amount: '300', cardId: 'fynn-own' }));
  await t.call('POST', '/api/expenses', ex({ title: 'Taxi', amount: '60', cardId: 'tara-own' }));
  await t.call('POST', '/api/expenses', ex({ title: 'Dinner', amount: '90', cardId: 'shared' }));
  await t.call('POST', '/api/expenses', ex({ title: 'Boat', amount: '120', cardId: 'max-own' }));
  const { data: s } = await t.call('GET', '/api/state');
  const plan = L.settlementPlan(s);
  assert.deepEqual(plan.transfers, [{ from: ['max'], to: ['fynn', 'tara'], baseMinor: 7000 }]);
  // record the payment, then everything is square
  const pay = await t.call('POST', '/api/settlements', { from: 'max', to: 'fynn', amount: '70.00' });
  assert.equal(pay.status, 201);
  assert.equal(L.settlementPlan(pay.data.state).transfers.length, 0);
  // undo it
  const id = pay.data.state.settlements[0].id;
  const undo = await t.call('DELETE', '/api/settlements/' + id);
  assert.equal(L.settlementPlan(undo.data.state).transfers.length, 1);
  await t.close();
});

test('editing keeps conversion, deleting hides, cards guard, base currency lock', async () => {
  const t = await boot();
  const created = (await t.call('POST', '/api/expenses', ex({ amount: '96', currency: 'USD' }))).data.expense;
  const edited = await t.call('PUT', '/api/expenses/' + created.id, ex({ title: 'Dinner 2', amount: '100', currency: 'USD', rate: created.rate, rateSource: 'auto' }));
  assert.equal(edited.status, 200);
  assert.equal(edited.data.expense.title, 'Dinner 2');
  assert.equal(edited.data.expense.baseMinor, 8000);
  assert.equal(edited.data.expense.createdAt, created.createdAt);

  assert.equal((await t.call('DELETE', '/api/cards/shared')).status, 409);
  assert.equal((await t.call('PUT', '/api/settings', { baseCurrency: 'EUR' })).status, 409);

  const del = await t.call('DELETE', '/api/expenses/' + created.id);
  assert.equal(del.data.state.expenses.length, 0);
  assert.equal((await t.call('DELETE', '/api/expenses/' + created.id)).status, 404);
  assert.equal((await t.call('PUT', '/api/settings', { baseCurrency: 'EUR' })).status, 200);

  const card = await t.call('POST', '/api/cards', { name: 'Holiday card', holders: ['fynn', 'tara'] });
  assert.equal(card.status, 201);
  assert.equal((await t.call('POST', '/api/cards', { name: 'x', holders: [] })).status, 400);
  const newId = card.data.state.cards.at(-1).id;
  assert.equal((await t.call('DELETE', '/api/cards/' + newId)).status, 200);
  await t.close();
});

test('data survives a restart and ETag polling works', async () => {
  const t = await boot();
  await t.call('POST', '/api/expenses', ex());
  const first = await t.call('GET', '/api/state');
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${first.data.version}"`);
  assert.equal((await t.call('GET', '/api/state', undefined, { 'if-none-match': etag })).status, 304);
  await t.close();

  const t2 = await boot({ dataDir: t.dataDir });
  const again = await t2.call('GET', '/api/state');
  assert.equal(again.data.expenses.length, 1);
  assert.equal(again.data.version, first.data.version);
  await t2.close();
});

test('concurrent writes are not lost', async () => {
  const t = await boot();
  const before = (await t.call('GET', '/api/state')).data.version;
  const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => t.call('POST', '/api/expenses', ex({ title: 'e' + i, amount: String(i + 1) }))));
  assert.ok(rs.every((r) => r.status === 201));
  const after = (await t.call('GET', '/api/state')).data;
  assert.equal(after.expenses.length, 25);
  assert.equal(after.version, before + 25);
  const onDisk = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'trip.json'), 'utf8'));
  assert.equal(onDisk.expenses.length, 25);
  await t.close();
});

test('PIN protects the API but not the login page', async () => {
  const t = await boot({ pin: '4321' });
  assert.equal((await t.call('GET', '/api/auth-required')).data.pin, true);
  assert.equal((await t.call('GET', '/api/state')).status, 401);
  assert.equal((await t.call('GET', '/api/state', undefined, { 'x-trip-pin': 'wrong' })).status, 401);
  assert.equal((await t.call('GET', '/api/state', undefined, { 'x-trip-pin': '4321' })).status, 200);
  assert.equal((await fetch(t.base + '/')).status, 200);
  await t.close();
});

test('people, settings and CSV export', async () => {
  const t = await boot();
  const p = await t.call('POST', '/api/people', { name: 'Sam' });
  assert.equal(p.data.state.people.at(-1).id, 'sam');
  assert.equal(p.data.state.cards.at(-1).name, "Sam's card");
  const s = await t.call('PUT', '/api/settings', { householdsOn: false, tripName: 'Panama 2026' });
  assert.equal(s.data.state.settings.householdsOn, false);
  assert.equal(s.data.state.trip.name, 'Panama 2026');
  assert.equal((await t.call('PUT', '/api/settings', { households: [['fynn']] })).status, 400);
  await t.call('POST', '/api/expenses', ex({ title: 'Lunch, with "quotes"', amount: '12.50' }));
  const csv = await t.call('GET', '/api/export.csv');
  assert.match(csv.data, /^Date,Location,Title,Card/);
  assert.match(csv.data, /"Lunch, with ""quotes"""/);
  await t.close();
});

test('static server blocks path traversal and dotfiles', async () => {
  const t = await boot();
  assert.equal((await fetch(t.base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(t.base + '/ledger.js')).status, 200);
  assert.equal((await fetch(t.base + '/nope.txt')).status, 404);
  await t.close();
});

test('rates: parses v1 and v2 shapes, adds PAB, falls back to cache when offline', async () => {
  const v1 = normalize({ amount: 1, base: 'GBP', date: '2026-11-02', rates: { USD: 1.3, EUR: 1.15 } }, 'GBP');
  assert.equal(v1.rates.PAB, 1.3);
  assert.equal(v1.rates.GBP, 1);
  const v2 = normalize([{ date: '2026-11-02', base: 'GBP', quote: 'USD', rate: 1.3 }], 'GBP');
  assert.equal(v2.rates.USD, 1.3);
  assert.throws(() => normalize({ rates: {} }, 'GBP'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
  let online = true;
  const fakeFetch = async () => {
    if (!online) throw new Error('offline');
    return { ok: true, json: async () => ({ date: '2026-11-02', rates: { USD: 1.3 } }) };
  };
  const r = createRates({ dataDir: dir, fetchImpl: fakeFetch, ttlMs: 0 });
  const a = await r.get('GBP');
  assert.equal(a.stale, false);
  online = false;
  const b = await r.get('GBP');
  assert.equal(b.stale, true);
  assert.equal(b.rates.USD, 1.3);
  const empty = await createRates({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rates-')), fetchImpl: fakeFetch }).get('GBP');
  assert.equal(empty.rates, null);
  assert.ok(empty.error);
});

test('Railway mode: refuses without a PIN or a volume, and binds all interfaces when set up properly', async () => {
  const { spawn } = require('node:child_process');
  const run = (env, waitMs) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out, p }));
    if (waitMs) setTimeout(() => resolve({ code: null, out, p }), waitMs);
  });
  const noPin = await run({ RAILWAY_ENVIRONMENT_NAME: 'production', DATA_DIR: os.tmpdir() });
  assert.equal(noPin.code, 1);
  assert.match(noPin.out, /TRIP_PIN/);
  const noVolume = await run({ RAILWAY_ENVIRONMENT_NAME: 'production', TRIP_PIN: 'x' });
  assert.equal(noVolume.code, 1);
  assert.match(noVolume.out, /volume/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
  const port = 38000 + Math.floor(Math.random() * 1000);
  const ok = await run({ RAILWAY_ENVIRONMENT_NAME: 'production', TRIP_PIN: 'x', RAILWAY_VOLUME_MOUNT_PATH: dir, PORT: String(port) }, 1500);
  try {
    assert.equal(ok.code, null, 'server should still be running: ' + ok.out);
    assert.match(ok.out, /0\.0\.0\.0/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
    assert.ok(fs.existsSync(path.join(dir, 'trip.json')), 'data is written to the volume path');
  } finally {
    ok.p.kill();
  }
});

test('PIN login sets a long-lived session cookie that replaces the header', async () => {
  const t = await boot({ pin: '4321' });
  const bad = await t.call('POST', '/api/login', { pin: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await fetch(t.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '4321' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /trip_auth=[0-9a-f]{64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=34560000/);
  const pair = cookie.split(';')[0];
  const withCookie = await fetch(t.base + '/api/state', { headers: { cookie: pair } });
  assert.equal(withCookie.status, 200);
  const auth = await (await fetch(t.base + '/api/auth-required', { headers: { cookie: pair } })).json();
  assert.deepEqual(auth, { pin: true, authed: true });
  const forged = await fetch(t.base + '/api/state', { headers: { cookie: 'trip_auth=' + '0'.repeat(64) } });
  assert.equal(forged.status, 401);
  const none = await (await fetch(t.base + '/api/auth-required')).json();
  assert.equal(none.authed, false);
});

test('expenses keep a tidied location and it appears in the CSV', async () => {
  const t = await boot();
  const a = await t.call('POST', '/api/expenses', ex({ location: '  Bocas   del Toro ' }));
  assert.equal(a.status, 201);
  const e = a.data.state.expenses[0];
  assert.equal(e.location, 'Bocas del Toro');
  const none = await t.call('POST', '/api/expenses', ex());
  assert.equal(none.data.state.expenses.find((x) => x.id !== e.id).location, '');
  const long = await t.call('POST', '/api/expenses', ex({ location: 'x'.repeat(200) }));
  assert.equal(long.data.state.expenses.find((x) => x.location.startsWith('xx')).location.length, 60);
  const upd = await t.call('PUT', '/api/expenses/' + e.id, ex({ location: 'Panama City' }));
  assert.equal(upd.data.state.expenses.find((x) => x.id === e.id).location, 'Panama City');
  const csv = await fetch(t.base + '/api/export.csv');
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^Date,Location,Title/);
  assert.match(text, /Panama City/);
});

test('default places are seeded and added to data saved before they existed', async () => {
  const t = await boot();
  assert.deepEqual((await t.call('GET', '/api/state')).data.settings.locations, ['Panama City', 'Pearl Islands', 'Altos de Cerro Azul']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-old-'));
  const old = { version: 7, trip: { name: 'Panama' }, settings: { baseCurrency: 'GBP', householdsOn: true }, people: [{ id: 'fynn', name: 'Fynn' }], cards: [{ id: 'shared', name: 'Shared card', holders: ['fynn'] }], households: [], expenses: [], settlements: [] };
  fs.writeFileSync(path.join(dir, 'trip.json'), JSON.stringify(old));
  const t2 = await boot({ dataDir: dir });
  const st = (await t2.call('GET', '/api/state')).data;
  assert.deepEqual(st.settings.locations, ['Panama City', 'Pearl Islands', 'Altos de Cerro Azul']);
  assert.equal(st.version, 8);
});

test('place photos: picks a free wide JPEG from the article images, skips maps, portraits and non-free files', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8000, 1)]);
  const calls = [];
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  const ok = (o) => json(o);
  const imgs = {
    'Pearl map.png': { mime: 'image/png', width: 2000, height: 1500, thumburl: 'u/m.png', extmetadata: { LicenseShortName: { value: 'CC BY 3.0' } } },
    'Tall beach.jpg': { mime: 'image/jpeg', width: 1500, height: 2400, thumburl: 'u/t.jpg', extmetadata: { LicenseShortName: { value: 'CC BY 3.0' } } },
    'Fair use shot.jpg': { mime: 'image/jpeg', width: 2400, height: 1200, thumburl: 'u/f.jpg', extmetadata: { LicenseShortName: { value: 'Non-free use rationale' } } },
    'Contadora lagoon.jpg': { mime: 'image/jpeg', width: 3000, height: 1800, thumburl: 'https://upload.wikimedia.org/thumb/c.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Contadora_lagoon.jpg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Jane &amp; Co</a>' } } },
    'Panama skyline.jpg': { mime: 'image/jpeg', width: 3000, height: 1500, thumburl: 'https://upload.wikimedia.org/thumb/p.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Panama_skyline.jpg', extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: 'Someone' } } },
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/page/summary/Panama_City')) return ok({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Panama_skyline.jpg' } });
    if (url.includes('/page/summary/')) return ok({});
    if (url.includes('/page/media-list/Panama_City')) return ok({ items: [] });
    if (url.includes('/page/media-list/Contadora_Island')) return ok({ items: [{ type: 'image', title: 'File:Pearl_map.png' }, { type: 'image', title: 'File:Pearl_locator_map.jpg' }, { type: 'image', title: 'File:Tall_beach.jpg' }, { type: 'image', title: 'File:Fair_use_shot.jpg' }, { type: 'image', title: 'File:Contadora_lagoon.jpg' }] });
    if (url.includes('/page/media-list/')) return ok({ items: [] });
    if (/generator=(search|categorymembers)/.test(url)) return ok({ query: { pages: [] } });
    if (url.includes('commons.wikimedia.org/w/api.php')) {
      const titles = decodeURIComponent(url.split('titles=')[1]).split('|').map((x) => x.replace(/^File:/, ''));
      return ok({ query: { pages: titles.filter((n) => imgs[n]).map((n) => ({ title: 'File:' + n, imageinfo: [imgs[n]] })) } });
    }
    if (url === 'https://upload.wikimedia.org/thumb/p.jpg' || url === 'https://upload.wikimedia.org/thumb/c.jpg') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => jpeg };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const t = await boot({ fetchImpl, log: () => {} });
  assert.equal((await fetch(t.base + '/photos/panama-city.jpg')).status, 404, 'nothing cached yet');
  await t.app.photos.ensureAll();
  const got = await fetch(t.base + '/photos/panama-city.jpg');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await got.arrayBuffer()).length, jpeg.length);
  const credits = await (await fetch(t.base + '/photos/credits.json')).json();
  assert.deepEqual(Object.keys(credits).sort(), ['panama-city', 'pearl-islands']);
  assert.equal(credits['panama-city'].credit, 'Photo: Someone · Public domain');
  assert.equal(credits['pearl-islands'].credit, 'Photo: Jane & Co · CC BY-SA 4.0', 'skipped the map, the portrait and the non-free file');
  assert.match(credits['pearl-islands'].url, /commons\.wikimedia\.org/);
  assert.equal((await fetch(t.base + '/photos/altos-de-cerro-azul.jpg')).status, 404, 'no usable photo keeps the illustration');
  assert.equal((await fetch(t.base + '/photos/..%2Ftrip.jpg')).status, 404);
  const before = calls.length;
  await t.app.photos.ensureAll(); // cached places are not fetched again
  assert.ok(!calls.slice(before).some((u) => u.includes('Panama_City') || u.includes('Contadora')));
});

test('photos are public but the expense API still needs the PIN', async () => {
  const t = await boot({ pin: '4321' });
  assert.equal((await fetch(t.base + '/photos/credits.json')).status, 200);
  assert.equal((await t.call('GET', '/api/state')).status, 401);
});

test('place photos: ranks place-like names first, never uses unrelated files for Panama City, refetches older cache', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8000, 1)]);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o });
  const mk = (n, thumb) => ({ mime: 'image/jpeg', width: 3000, height: 1800, thumburl: thumb, descriptionurl: 'https://commons.wikimedia.org/wiki/File:' + n, extmetadata: { LicenseShortName: { value: 'CC BY 3.0' }, Artist: { value: 'A' } } });
  const fetchImpl = async (url) => {
    if (url.includes('/page/summary/')) return ok({});
    if (url.includes('/media-list/Panama_City')) return ok({ items: ['Panama_Papers_(1).jpeg', 'Street_market.jpg', 'Casco_antiguo_plazita.jpg', 'Panama_City_skyline_at_dusk.jpg'].map((title) => ({ type: 'image', title: 'File:' + title })) });
    if (url.includes('/media-list/Contadora_Island')) return ok({ items: ['Main_boulevard.jpg', 'Playa_Galeon_Villa.jpg', 'Playa_Galeon_beach.jpg'].map((title) => ({ type: 'image', title: 'File:' + title })) });
    if (url.includes('/media-list/Cerro_Azul')) return ok({ items: [{ type: 'image', title: 'File:Plain_house.jpg' }] });
    if (/generator=(search|categorymembers)/.test(url)) return ok({ query: { pages: [] } });
    if (url.includes('commons.wikimedia.org/w/api.php')) {
      const titles = decodeURIComponent(url.split('titles=')[1]).split('|').map((x) => x.replace(/^File:/, ''));
      return ok({ query: { pages: titles.map((n) => ({ title: 'File:' + n, imageinfo: [mk(n, 'https://upload.wikimedia.org/thumb/' + n)] })) } });
    }
    if (url.startsWith('https://upload.wikimedia.org/thumb/')) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => jpeg };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-ph-'));
  const t = await boot({ dataDir: dir, fetchImpl, log: () => {} });
  await t.app.photos.ensureAll();
  const credits = await (await fetch(t.base + '/photos/credits.json')).json();
  assert.equal(credits['panama-city'].file, 'Panama City skyline at dusk.jpg', 'skips the Papers photo, picks the skyline over an old-town plaza');
  assert.equal(credits['pearl-islands'].file, 'Playa Galeon beach.jpg', 'beach outranks a villa and a boulevard');
  assert.equal(credits['altos-de-cerro-azul'].file, 'Plain house.jpg', 'non-strict places fall back to the first free photo');
  fs.writeFileSync(path.join(dir, 'places', 'panama-city.json'), JSON.stringify({ credit: 'old', url: 'u', file: 'x' })); // cached by an older picker
  await t.app.photos.ensureAll();
  assert.equal((await (await fetch(t.base + '/photos/credits.json')).json())['panama-city'].file, 'Panama City skyline at dusk.jpg');
});

test('place photos: searches Commons for beach shots whose names tie them to the place', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8000, 1)]);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o });
  const mk = (n) => ({ mime: 'image/jpeg', width: 3000, height: 1800, thumburl: 'https://upload.wikimedia.org/thumb/' + n, descriptionurl: 'https://commons.wikimedia.org/wiki/File:' + n, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'Pat' } } });
  const searches = [];
  const fetchImpl = async (url) => {
    if (url.includes('generator=categorymembers')) {
      const cat = decodeURIComponent(url.split('gcmtitle=')[1].split('&')[0]);
      return ok({ query: { pages: cat === 'Category:Beaches of Panama' ? [{ title: 'File:Bocas del Toro beach.jpg', imageinfo: [mk('Bocas del Toro beach.jpg')] }, { title: 'File:Rusty ruin.png', imageinfo: [mk('Rusty ruin.png')] }] : [] } });
    }
    if (url.includes('generator=search')) {
      const q = decodeURIComponent(url.split('gsrsearch=')[1].split('&')[0]);
      searches.push(q);
      const files = q.startsWith('Contadora beach')
        ? ['Contadora beach wreck (1).jpg', 'Contadora beach sunset.jpg', 'Pearl Beach NSW Australia.jpg', 'Contadora hotel lobby.jpg', 'Panama beach map.jpg']
        : [];
      return ok({ query: { pages: files.map((n) => ({ title: 'File:' + n, imageinfo: [mk(n)] })) } });
    }
    if (url.includes('/page/summary/')) return ok({});
    if (url.includes('/media-list/Contadora_Island')) return ok({ items: [{ type: 'image', title: 'File:Main_boulevard.jpg' }] });
    if (url.includes('/media-list/')) return ok({ items: [] });
    if (url.includes('commons.wikimedia.org/w/api.php')) {
      const titles = decodeURIComponent(url.split('titles=')[1]).split('|').map((x) => x.replace(/^File:/, ''));
      return ok({ query: { pages: titles.map((n) => ({ title: 'File:' + n, imageinfo: [mk(n)] })) } });
    }
    if (url.startsWith('https://upload.wikimedia.org/thumb/')) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => jpeg };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const t = await boot({ fetchImpl, log: () => {} });
  await t.app.photos.ensureAll();
  const credits = await (await fetch(t.base + '/photos/credits.json')).json();
  assert.equal(credits['pearl-islands'].file, 'Contadora beach sunset.jpg', 'a beach photo found by search beats the boulevard, and a wreck is ranked last');
  assert.ok(searches.some((q) => q.startsWith('Contadora beach') && q.endsWith('filetype:bitmap')));
  assert.equal(credits['panama-city'], undefined, 'strict places keep the illustration when nothing fits');
});

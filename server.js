'use strict';
/*
 * Panama splitter server. Zero dependencies (Node 20+).
 *   node server.js
 * Env: PORT (3000), HOST (127.0.0.1), DATA_DIR (./data), TRIP_PIN (optional shared PIN).
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./public/ledger.js');
const { createRates } = require('./lib/rates.js');
const { createPhotos } = require('./lib/photos.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}
const bad = (msg, code, status) => new HttpError(status || 400, msg, code || 'bad_request');
const newId = () => crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

const DEFAULT_LOCATIONS = ['Panama City', 'Pearl Islands', 'Altos de Cerro Azul'];

function seedState() {
  return {
    version: 1,
    trip: { name: 'Panama' },
    settings: { baseCurrency: 'GBP', householdsOn: true, locations: [...DEFAULT_LOCATIONS] },
    people: [{ id: 'fynn', name: 'Fynn' }, { id: 'tara', name: 'Tara' }, { id: 'max', name: 'Max' }],
    cards: [
      { id: 'shared', name: 'Shared card', holders: ['fynn', 'tara'] },
      { id: 'fynn-own', name: "Fynn's card", holders: ['fynn'] },
      { id: 'tara-own', name: "Tara's card", holders: ['tara'] },
      { id: 'max-own', name: "Max's card", holders: ['max'] },
    ],
    households: [['fynn', 'tara']],
    expenses: [],
    settlements: [],
  };
}

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
  const pin = opts.pin !== undefined ? opts.pin : process.env.TRIP_PIN || '';
  const rates = opts.ratesProvider || createRates({ dataDir });
  const photos = createPhotos({ dataDir, fetchImpl: opts.fetchImpl, log: opts.log });
  const file = path.join(dataDir, 'trip.json');
  let state = null;
  let chain = Promise.resolve();

  const pinDigest = pin ? crypto.createHash('sha256').update(pin).digest() : null;
  // Long-lived session cookie: derived from the PIN, so changing the PIN signs everyone out.
  const COOKIE = 'trip_auth';
  const COOKIE_MAX_AGE = 400 * 24 * 3600; // browsers cap cookie lifetime at about 400 days
  const sessionToken = pin ? crypto.createHmac('sha256', pin).update('trip-session-v1').digest('hex') : '';
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const pinOk = (given) => crypto.timingSafeEqual(sha(given), pinDigest);
  function cookieOf(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }
  const hasSession = (req) => !!sessionToken && crypto.timingSafeEqual(sha(cookieOf(req, COOKIE)), sha(sessionToken));
  function checkPin(req) {
    if (!pinDigest) return true;
    return pinOk(req.headers['x-trip-pin'] || '') || hasSession(req);
  }

  async function load() {
    await fsp.mkdir(dataDir, { recursive: true });
    try {
      state = JSON.parse(await fsp.readFile(file, 'utf8'));
      await fsp.copyFile(file, file + '.bak').catch(() => {});
      if (!Array.isArray(state.settings.locations)) { // data saved before locations existed
        state.settings.locations = [...DEFAULT_LOCATIONS];
        state.version += 1;
        await write(state);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      state = seedState();
      await write(state);
    }
  }

  async function write(next) {
    await fsp.writeFile(file + '.tmp', JSON.stringify(next, null, 2));
    await fsp.rename(file + '.tmp', file);
  }

  /** Serialises every change: clone, mutate, bump version, write to disk, then swap in. */
  function mutate(fn) {
    const run = chain.then(async () => {
      const next = structuredClone(state);
      const result = await fn(next);
      next.version = state.version + 1;
      await write(next);
      state = next;
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  const view = (s) => ({
    version: s.version,
    trip: s.trip,
    settings: s.settings,
    people: s.people,
    cards: s.cards,
    households: s.households,
    expenses: s.expenses.filter((e) => !e.deletedAt),
    settlements: s.settlements.filter((x) => !x.deletedAt),
  });

  function normaliseSplit(split, s) {
    const w = split && split.weights ? split.weights
      : split && Array.isArray(split.among) ? Object.fromEntries(split.among.map((id) => [id, 1])) : null;
    if (!w) throw bad('Choose who shares this expense');
    const out = {};
    for (const [id, v] of Object.entries(w)) {
      if (!s.people.some((p) => p.id === id)) throw bad('Unknown person: ' + id);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw bad('Invalid share for ' + id);
      if (n > 0) out[id] = n;
    }
    if (!Object.keys(out).length) throw bad('Choose who shares this expense');
    return out;
  }

  async function buildExpense(input, s, existing) {
    const base = s.settings.baseCurrency;
    const title = String(input.title || '').trim();
    if (!title || title.length > 80) throw bad('Title is required (80 characters max)');
    const currency = String(input.currency || base).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw bad('Invalid currency code');
    const amountMinor = L.parseAmount(input.amount, currency);
    if (!amountMinor || amountMinor <= 0) throw bad('Enter a valid amount');
    const card = s.cards.find((c) => c.id === input.cardId);
    if (!card) throw bad('Choose which card paid');
    const weights = normaliseSplit(input.split, s);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : nowIso().slice(0, 10);
    const note = String(input.note || '').slice(0, 200);
    const location = String(input.location || '').replace(/\s+/g, ' ').trim().slice(0, 60);

    let baseMinor;
    let rate;
    let rateSource;
    if (currency === base) {
      baseMinor = amountMinor;
      rate = 1;
      rateSource = 'base';
    } else if (input.actualBase !== undefined && input.actualBase !== null && input.actualBase !== '') {
      baseMinor = L.parseAmount(input.actualBase, base);
      if (!baseMinor || baseMinor <= 0) throw bad('Invalid amount charged in ' + base);
      rate = L.effectiveRate(amountMinor, currency, baseMinor, base);
      rateSource = 'actual';
    } else {
      let r = Number(input.rate);
      if (r > 0) {
        rateSource = input.rateSource === 'auto' ? 'auto' : 'manual';
      } else {
        r = L.rateToBase(await rates.get(base), currency);
        if (!(r > 0)) throw bad(`No exchange rate for ${currency}. Enter a rate, or the amount charged in ${base}.`, 'no_rate', 422);
        rateSource = 'auto';
      }
      rate = r;
      baseMinor = L.convertMinor(amountMinor, currency, base, r);
      if (baseMinor <= 0) throw bad('Converted amount rounds to zero');
    }
    const createdBy = s.people.some((p) => p.id === input.createdBy) ? input.createdBy : null;
    const ts = nowIso();
    return {
      id: existing ? existing.id : newId(),
      title, date, currency, amountMinor, baseMinor,
      rate: Number(Number(rate).toPrecision(8)), rateSource,
      cardId: card.id, split: { weights }, note, location,
      createdBy: existing ? existing.createdBy : createdBy,
      createdAt: existing ? existing.createdAt : ts,
      updatedAt: ts,
    };
  }

  function cleanName(v, label, max) {
    const s = String(v || '').trim();
    if (!s || s.length > (max || 40)) throw bad(`${label} is required (${max || 40} characters max)`);
    return s;
  }

  function cleanHolders(h, s) {
    if (!Array.isArray(h) || !h.length) throw bad('A card needs at least one holder');
    const uniq = [...new Set(h)];
    for (const id of uniq) if (!s.people.some((p) => p.id === id)) throw bad('Unknown person: ' + id);
    return uniq;
  }

  const csvCell = (v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };

  function toCsv(s) {
    const base = s.settings.baseCurrency;
    const name = (id) => (s.people.find((p) => p.id === id) || { name: id }).name;
    const rows = [['Date', 'Location', 'Title', 'Card', 'Currency', 'Amount', 'Base currency', 'Base amount', 'Rate', 'Rate source', 'Split', 'Notes']];
    for (const e of s.expenses.filter((x) => !x.deletedAt).sort((a, b) => a.date.localeCompare(b.date))) {
      const card = s.cards.find((c) => c.id === e.cardId);
      rows.push([
        e.date, e.location || '', e.title, card ? card.name : e.cardId, e.currency, L.minorToInput(e.amountMinor, e.currency),
        base, L.minorToInput(e.baseMinor, base), e.rate, e.rateSource,
        Object.entries(e.split.weights).map(([id, w]) => `${name(id)}:${w}`).join(' '), e.note || '',
      ]);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 1e6) throw bad('Request too large', 'too_large', 413);
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      throw bad('Invalid JSON');
    }
  }

  function send(res, status, body, headers) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;
    let match;

    if (m === 'GET' && p === '/api/state') {
      const etag = `"${state.version}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-store' });
        return res.end();
      }
      return send(res, 200, view(state), { etag });
    }

    if (m === 'GET' && p === '/api/rates') {
      return send(res, 200, await rates.get(state.settings.baseCurrency, { refresh: url.searchParams.get('refresh') === '1' }));
    }

    if (m === 'GET' && p === '/api/export.csv') {
      return send(res, 200, toCsv(state), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="trip-expenses.csv"',
      });
    }

    if (m === 'POST' && p === '/api/expenses') {
      const body = await readBody(req);
      const expense = await mutate(async (s) => {
        const e = await buildExpense(body, s, null);
        s.expenses.push(e);
        return e;
      });
      return send(res, 201, { expense, state: view(state) });
    }

    if ((match = p.match(/^\/api\/expenses\/([\w-]+)$/))) {
      const id = match[1];
      if (m === 'PUT') {
        const body = await readBody(req);
        const expense = await mutate(async (s) => {
          const i = s.expenses.findIndex((e) => e.id === id && !e.deletedAt);
          if (i < 0) throw bad('Expense not found', 'not_found', 404);
          s.expenses[i] = await buildExpense(body, s, s.expenses[i]);
          return s.expenses[i];
        });
        return send(res, 200, { expense, state: view(state) });
      }
      if (m === 'DELETE') {
        await mutate(async (s) => {
          const e = s.expenses.find((x) => x.id === id && !x.deletedAt);
          if (!e) throw bad('Expense not found', 'not_found', 404);
          e.deletedAt = nowIso();
        });
        return send(res, 200, { state: view(state) });
      }
    }

    if (m === 'POST' && p === '/api/settlements') {
      const body = await readBody(req);
      await mutate(async (s) => {
        const has = (id) => s.people.some((x) => x.id === id);
        if (!has(body.from) || !has(body.to) || body.from === body.to) throw bad('Choose two different people');
        const base = s.settings.baseCurrency;
        const baseMinor = Number.isInteger(body.baseMinor) ? body.baseMinor : L.parseAmount(body.amount, base);
        if (!baseMinor || baseMinor <= 0) throw bad('Enter a valid amount');
        s.settlements.push({
          id: newId(), from: body.from, to: body.to, baseMinor,
          date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : nowIso().slice(0, 10),
          note: String(body.note || '').slice(0, 200), createdAt: nowIso(),
        });
      });
      return send(res, 201, { state: view(state) });
    }

    if ((match = p.match(/^\/api\/settlements\/([\w-]+)$/)) && m === 'DELETE') {
      await mutate(async (s) => {
        const x = s.settlements.find((q) => q.id === match[1] && !q.deletedAt);
        if (!x) throw bad('Payment not found', 'not_found', 404);
        x.deletedAt = nowIso();
      });
      return send(res, 200, { state: view(state) });
    }

    if (m === 'POST' && p === '/api/cards') {
      const body = await readBody(req);
      await mutate(async (s) => {
        s.cards.push({ id: newId(), name: cleanName(body.name, 'Card name'), holders: cleanHolders(body.holders, s) });
      });
      return send(res, 201, { state: view(state) });
    }

    if ((match = p.match(/^\/api\/cards\/([\w-]+)$/))) {
      const id = match[1];
      if (m === 'PUT') {
        const body = await readBody(req);
        await mutate(async (s) => {
          const c = s.cards.find((x) => x.id === id);
          if (!c) throw bad('Card not found', 'not_found', 404);
          if (body.name !== undefined) c.name = cleanName(body.name, 'Card name');
          if (body.holders !== undefined) c.holders = cleanHolders(body.holders, s);
        });
        return send(res, 200, { state: view(state) });
      }
      if (m === 'DELETE') {
        await mutate(async (s) => {
          if (!s.cards.some((x) => x.id === id)) throw bad('Card not found', 'not_found', 404);
          if (s.expenses.some((e) => !e.deletedAt && e.cardId === id)) throw bad('This card has expenses, so it cannot be removed', 'in_use', 409);
          if (s.cards.length <= 1) throw bad('Keep at least one card');
          s.cards = s.cards.filter((x) => x.id !== id);
        });
        return send(res, 200, { state: view(state) });
      }
    }

    if (m === 'POST' && p === '/api/people') {
      const body = await readBody(req);
      await mutate(async (s) => {
        const name = cleanName(body.name, 'Name', 30);
        if (s.people.length >= 12) throw bad('That is plenty of people');
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person';
        while (s.people.some((x) => x.id === id)) id += '-' + newId().slice(0, 2);
        s.people.push({ id, name });
        s.cards.push({ id: newId(), name: `${name}'s card`, holders: [id] });
      });
      return send(res, 201, { state: view(state) });
    }

    if (m === 'PUT' && p === '/api/settings') {
      const body = await readBody(req);
      await mutate(async (s) => {
        if ('householdsOn' in body) s.settings.householdsOn = !!body.householdsOn;
        if (body.tripName !== undefined) s.trip.name = cleanName(body.tripName, 'Trip name');
        if (Array.isArray(body.households)) {
          const seen = new Set();
          s.households = body.households.map((g) => {
            const grp = cleanHolders(g, s);
            if (grp.length < 2) throw bad('A household needs at least two people');
            grp.forEach((id) => {
              if (seen.has(id)) throw bad('Someone is in two households');
              seen.add(id);
            });
            return grp;
          });
        }
        if (body.baseCurrency) {
          const cur = String(body.baseCurrency).toUpperCase();
          if (!/^[A-Z]{3}$/.test(cur)) throw bad('Invalid currency code');
          if (cur !== s.settings.baseCurrency) {
            if (s.expenses.some((e) => !e.deletedAt) || s.settlements.some((x) => !x.deletedAt)) {
              throw bad('The base currency can only change while the trip has no expenses', 'locked', 409);
            }
            s.settings.baseCurrency = cur;
          }
        }
      });
      return send(res, 200, { state: view(state) });
    }

    throw bad('Not found', 'not_found', 404);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch (err) {
      return send(res, 400, { error: 'bad_path' });
    }
    if (rel === '/') rel = '/index.html';
    const full = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || path.basename(full).startsWith('.')) return send(res, 404, { error: 'not_found' });
    try {
      const data = await fsp.readFile(full);
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      send(res, 404, { error: 'not_found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/photos/')) { // generic place photos from Wikimedia: not private, so no PIN
        if (url.pathname === '/photos/credits.json') return send(res, 200, await photos.credits(), { 'cache-control': 'no-cache' });
        const m = /^\/photos\/([a-z0-9-]+)\.jpg$/.exec(url.pathname);
        const buf = m && (await photos.read(m[1]));
        if (!buf) return send(res, 404, { error: 'not_found' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(buf);
      }
      if (url.pathname === '/api/auth-required') return send(res, 200, { pin: !!pinDigest, authed: !pinDigest || hasSession(req) });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!pinDigest) return send(res, 200, { ok: true });
        const body = await readBody(req);
        if (!pinOk((body && body.pin) || '')) {
          await new Promise((r) => setTimeout(r, 400));
          return send(res, 401, { error: 'pin_required', message: 'Wrong PIN' });
        }
        const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${sessionToken}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}` });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!checkPin(req)) {
          await new Promise((r) => setTimeout(r, 400));
          return send(res, 401, { error: 'pin_required', message: 'PIN required' });
        }
        return await api(req, res, url);
      }
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      return send(res, 500, { error: 'server_error', message: 'Something went wrong' });
    }
  });

  const ready = load();
  return { server, ready, dataDir, photos, getState: () => state, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { createApp, seedState, DEFAULT_LOCATIONS };

if (require.main === module) {
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (onRailway ? '0.0.0.0' : '127.0.0.1');
  if (onRailway && !process.env.TRIP_PIN) {
    console.error('Refusing to start on Railway without TRIP_PIN: the app would be public with no password. Set TRIP_PIN in the service variables.');
    process.exit(1);
  }
  if (onRailway && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.error('Refusing to start on Railway without a volume: data would be lost on every deploy. Add a volume to this service (or set DATA_DIR to its mount path).');
    process.exit(1);
  }
  const app = createApp();
  app.ready.then(() => {
    app.server.listen(port, host, () => {
      console.log(`Panama splitter on http://${host}:${port}  (data: ${app.dataDir})`);
      if (!process.env.TRIP_PIN) console.log('No TRIP_PIN set: fine inside a private tailnet, set one before using Tailscale Funnel.');
      if (process.env.PLACE_PHOTOS !== '0') app.photos.ensureAll().catch((err) => console.error('place photos:', err.message));
    });
  }).catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

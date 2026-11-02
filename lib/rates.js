'use strict';
/*
 * Exchange-rate cache. Fetches ECB reference rates (via Frankfurter, no API key),
 * caches them on disk, and falls back to the last cached copy when offline.
 * Rates are stored per 1 unit of the trip's base currency.
 */
const fs = require('node:fs');
const path = require('node:path');

const URLS = (base) => [
  `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`,
  `https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base)}`,
];

/** Accepts the v1 shape ({date, rates:{USD:1.3}}) or a v2-style array of {date, quote, rate}. */
function normalize(json, base) {
  const rates = {};
  let date = null;
  if (json && json.rates && !Array.isArray(json.rates)) {
    Object.assign(rates, json.rates);
    date = json.date || null;
  } else {
    const rows = Array.isArray(json) ? json : json && Array.isArray(json.rates) ? json.rates : null;
    if (!rows) throw new Error('unrecognised rates response');
    for (const r of rows) {
      if (r && r.quote && r.rate) rates[r.quote] = r.rate;
      if (r && r.date && !date) date = r.date;
    }
  }
  for (const k of Object.keys(rates)) {
    if (!(Number.isFinite(rates[k]) && rates[k] > 0)) delete rates[k];
  }
  if (!Object.keys(rates).length) throw new Error('no usable rates in response');
  // The Panamanian balboa is pegged 1:1 to the US dollar and is not in ECB data.
  if (rates.USD && !rates.PAB) rates.PAB = rates.USD;
  rates[base] = 1;
  return { base, date, rates };
}

function createRates({ dataDir, fetchImpl, ttlMs = 12 * 3600 * 1000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const file = dataDir ? path.join(dataDir, 'rates.json') : null;
  let cache = {};
  try {
    if (file && fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    cache = {};
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(cache));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      /* cache is best effort */
    }
  }

  async function fetchRates(base) {
    let lastErr;
    for (const url of URLS(base)) {
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const out = normalize(await res.json(), base);
        out.fetchedAt = Date.now();
        return out;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('rates unavailable');
  }

  /** Returns { base, date, fetchedAt, rates|null, stale, error? } and never throws. */
  async function get(base, { refresh = false } = {}) {
    const hit = cache[base];
    if (!refresh && hit && Date.now() - hit.fetchedAt < ttlMs) return { ...hit, stale: false };
    try {
      cache[base] = await fetchRates(base);
      save();
      return { ...cache[base], stale: false };
    } catch (err) {
      if (hit) return { ...hit, stale: true, error: String(err.message || err) };
      return { base, date: null, fetchedAt: null, rates: null, stale: true, error: String(err.message || err) };
    }
  }

  return { get, normalize };
}

module.exports = { createRates, normalize };

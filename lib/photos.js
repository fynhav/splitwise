'use strict';
/*
 * Place photos: for each known place the server looks up the lead image of a Wikipedia article,
 * keeps it only if it is a freely licensed landscape JPEG on Wikimedia Commons, and caches it
 * (with its credit) in DATA_DIR/places. Anything that fails leaves the bundled illustration in place.
 */
const fsp = require('node:fs').promises;
const path = require('node:path');

const USER_AGENT = 'TripSplitter/1.0 (https://github.com/fynhav/splitwise; private trip expense app)';

// slug -> Wikipedia articles to try, in order. The first with a usable photo wins.
// titles: Wikipedia articles whose images are considered. queries: Commons searches (results must also match `require`).
// prefer: keywords best first; filenames matching an earlier keyword win. strict: no keyword match, no photo (keep the illustration).
const PLACES = {
  'panama-city': { titles: ['Panama City'], queries: [], prefer: ['skyline', 'panoram', 'punta', 'costa del este', 'bay', 'view', 'casco', 'ancon'], strict: true },
  'pearl-islands': {
    titles: ['Contadora Island', 'Pearl Islands', 'Isla del Rey'],
    queries: ['Contadora beach', 'Isla Contadora playa', 'Pearl Islands Panama beach', 'Playa Galeón'],
    require: /contadora|perlas|pearl islands|gale[oó]n|saboga|isla del rey|san jos[eé]|pedro gonz|mogo|viveros|panam[aá]/i,
    prefer: ['beach', 'playa', 'sand', 'palm', 'bay', 'coast', 'ocean', 'lagoon', 'sunset'],
    strict: true,
  },
  'altos-de-cerro-azul': { titles: ['Cerro Azul, Panama'], queries: [], prefer: ['view', 'mountain', 'cerro', 'vig[ií]a', 'valley', 'forest', 'hill', 'landscape', 'lookout'], strict: false },
};
const AVOID = /villa|house|hotel|resort|building|boulevard|street|market|plaza|church|interior|room/i; // ranked last, not rejected
const PHOTO_VERSION = 4; // bump to refetch what is already cached

const FREE_LICENSE = /^(cc[ -]|public domain|pd[ -]|cc0)/i;
const MAX_BYTES = 3 * 1024 * 1024;

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

function createPhotos({ dataDir, fetchImpl, log } = {}) {
  const dir = path.join(dataDir, 'places');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const say = log || ((...a) => console.log(...a));
  const slugs = Object.keys(PLACES);

  async function getJson(url) {
    const res = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  const BAD_NAME = /(map|flag|logo|coat[ _]of|seal|locator|location|icon|diagram|chart|sprite|symbol|signature|papers|protest|conference|meeting|president|portrait|people|crowd|stamp|poster|interview)/i;

  const IMAGEINFO = 'prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900';

  /** A Commons file is usable if it is a free, wide, large JPEG. Counts reasons in `why`. */
  function vet(file, ii, title, why) {
    if (!ii || !ii.thumburl) { why.notOnCommons++; return null; }
    if (ii.mime !== 'image/jpeg') { why.notJpeg++; return null; }
    if (!(ii.width / ii.height >= 1.25)) { why.notWide++; return null; }
    if (ii.width < 1200) { why.small++; return null; }
    const meta = ii.extmetadata || {};
    const license = stripTags(meta.LicenseShortName && meta.LicenseShortName.value);
    if (!FREE_LICENSE.test(license)) { why.license++; return null; }
    const artist = stripTags(meta.Artist && meta.Artist.value).slice(0, 60);
    return { file, thumb: ii.thumburl, page: ii.descriptionurl, license, artist, title };
  }
  const goodName = (n) => /\.jpe?g$/i.test(n) && !BAD_NAME.test(n);
  const cleanName = (n) => decodeURIComponent(String(n || '').replace(/^File:/i, '')).replace(/_/g, ' ');

  /** Free landscape JPEGs among a Wikipedia article's images (lead image first). */
  async function articleCandidates(title, why) {
    const slug = encodeURIComponent(title.replace(/ /g, '_'));
    const names = [];
    const add = (n) => { n = cleanName(n); if (n && goodName(n) && !names.includes(n)) names.push(n); };
    try {
      const sum = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
      const src = sum.originalimage && sum.originalimage.source;
      if (src && src.includes('/wikipedia/commons/')) add(src.split('/').pop());
    } catch (e) { /* the media list below may still work */ }
    const list = await getJson(`https://en.wikipedia.org/api/rest_v1/page/media-list/${slug}`);
    for (const it of list.items || []) if (it.type === 'image') add(it.title);
    const picked = names.slice(0, 20);
    if (!picked.length) return [];
    const info = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&${IMAGEINFO}&titles=${encodeURIComponent(picked.map((n) => 'File:' + n).join('|'))}`);
    const byName = new Map();
    for (const p of (info.query && info.query.pages) || []) if (p.imageinfo && p.imageinfo[0]) byName.set(cleanName(p.title), p.imageinfo[0]);
    return picked.map((n) => vet(n, byName.get(n), title, why)).filter(Boolean);
  }

  /** Free landscape JPEGs from a Commons search whose file names also match `require`. */
  async function searchCandidates(query, require, why) {
    const info = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=30&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&${IMAGEINFO}`);
    const out = [];
    for (const p of (info.query && info.query.pages) || []) {
      const n = cleanName(p.title);
      if (!goodName(n) || (require && !require.test(n))) continue;
      const v = vet(n, p.imageinfo && p.imageinfo[0], `search: ${query}`, why);
      if (v) out.push(v);
    }
    return out;
  }

  async function download(url) {
    const res = await doFetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading photo`);
    if (!String(res.headers.get('content-type') || '').startsWith('image/jpeg')) throw new Error('not a JPEG');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5000 || buf.length > MAX_BYTES) throw new Error(`unexpected size ${buf.length}`);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
    return buf;
  }

  async function fetchOne(slug) {
    const { titles, queries = [], require, prefer, strict } = PLACES[slug];
    const why = { notOnCommons: 0, notJpeg: 0, notWide: 0, small: 0, license: 0 };
    let found = [];
    for (const title of titles) {
      try { found.push(...(await articleCandidates(title, why))); } catch (err) { say(`place photo ${slug}: article "${title}" failed: ${err.message}`); }
    }
    for (const q of queries) {
      try { found.push(...(await searchCandidates(q, require, why))); } catch (err) { say(`place photo ${slug}: search "${q}" failed: ${err.message}`); }
    }
    found = found.filter((f, i) => found.findIndex((g) => g.file === f.file) === i);
    const rank = (f) => (AVOID.test(f.file) ? 100 : 0) + (prefer.findIndex((k) => new RegExp(k, 'i').test(f.file)) + 1 || 51);
    found.forEach((f) => { f.rank = rank(f); f.matched = prefer.some((k) => new RegExp(k, 'i').test(f.file)); });
    found.sort((a, b) => a.rank - b.rank); // stable: ties keep discovery order
    if (strict) found = found.filter((f) => f.matched);
    if (!found.length) { say(`place photo ${slug}: no usable free photo, keeping the illustration (rejected ${JSON.stringify(why)})`); return false; }
    let c = null;
    let buf = null;
    for (const f of found.slice(0, 3)) { // the first that downloads cleanly
      try { buf = await download(f.thumb); c = f; break; } catch (err) { say(`place photo ${slug}: ${f.file} download failed: ${err.message}`); }
    }
    if (!buf) return false;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, slug + '.jpg.tmp'), buf);
      await fsp.rename(path.join(dir, slug + '.jpg.tmp'), path.join(dir, slug + '.jpg'));
      const credit = `Photo: ${c.artist || 'Wikimedia Commons'} · ${c.license}`;
      await fsp.writeFile(path.join(dir, slug + '.json'), JSON.stringify({ v: PHOTO_VERSION, credit, url: c.page, file: c.file, article: c.title }));
      say(`place photo ${slug}: saved ${c.file} (${c.license}, ${buf.length} bytes); other options: ${found.filter((f) => f !== c).slice(0, 8).map((f) => f.file).join(' | ') || 'none'}`);
      return true;
    } catch (err) {
      say(`place photo ${slug}: could not save: ${err.message}`);
      return false;
    }
  }

  /** Fetches whatever is missing. Never throws: a failure just keeps the illustration. */
  async function ensureAll() {
    for (const slug of slugs) {
      try {
        await fsp.access(path.join(dir, slug + '.jpg'));
        const meta = JSON.parse(await fsp.readFile(path.join(dir, slug + '.json'), 'utf8'));
        if (meta.v !== PHOTO_VERSION) throw new Error('older picker');
      } catch (e) {
        await fetchOne(slug);
      }
    }
  }

  async function credits() {
    const out = {};
    for (const slug of slugs) {
      try {
        await fsp.access(path.join(dir, slug + '.jpg'));
        out[slug] = JSON.parse(await fsp.readFile(path.join(dir, slug + '.json'), 'utf8'));
      } catch (e) { /* not cached yet */ }
    }
    return out;
  }

  async function read(slug) {
    if (!PLACES[slug]) return null;
    try { return await fsp.readFile(path.join(dir, slug + '.jpg')); } catch (e) { return null; }
  }

  return { ensureAll, credits, read, slugs };
}

module.exports = { createPhotos, PLACES };

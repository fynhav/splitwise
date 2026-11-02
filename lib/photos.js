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
const PLACES = {
  'panama-city': ['Panama City'],
  'pearl-islands': ['Contadora Island', 'Pearl Islands', 'Isla del Rey'],
  'altos-de-cerro-azul': ['Cerro Azul, Panama', 'Cerro Azul (Panama)'],
};

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

  const BAD_NAME = /(map|flag|logo|coat[ _]of|seal|locator|location|icon|diagram|chart|panorama_of_the_world|sprite|symbol|signature)/i;

  /** Free landscape JPEGs among an article's images (lead image first), best first. */
  async function candidates(title) {
    const slug = encodeURIComponent(title.replace(/ /g, '_'));
    const names = [];
    const add = (n) => { n = decodeURIComponent(String(n || '').replace(/^File:/i, '')).replace(/_/g, ' '); if (n && /\.jpe?g$/i.test(n) && !BAD_NAME.test(n) && !names.includes(n)) names.push(n); };
    try {
      const sum = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
      const src = sum.originalimage && sum.originalimage.source;
      if (src && src.includes('/wikipedia/commons/')) add(src.split('/').pop());
    } catch (e) { /* the media list below may still work */ }
    const list = await getJson(`https://en.wikipedia.org/api/rest_v1/page/media-list/${slug}`);
    for (const it of list.items || []) if (it.type === 'image') add(it.title);
    const picked = names.slice(0, 20);
    if (!picked.length) return { found: [], why: 'no JPEG images on the article' };
    const info = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900&titles=${encodeURIComponent(picked.map((n) => 'File:' + n).join('|'))}`);
    const byName = new Map();
    for (const p of (info.query && info.query.pages) || []) if (p.imageinfo && p.imageinfo[0]) byName.set(String(p.title).replace(/^File:/i, '').replace(/_/g, ' '), p.imageinfo[0]);
    const found = [];
    const why = { notOnCommons: 0, notJpeg: 0, notWide: 0, small: 0, license: 0 };
    for (const n of picked) {
      const ii = byName.get(n);
      if (!ii || !ii.thumburl) { why.notOnCommons++; continue; }
      if (ii.mime !== 'image/jpeg') { why.notJpeg++; continue; }
      if (!(ii.width / ii.height >= 1.25)) { why.notWide++; continue; }
      if (ii.width < 1200) { why.small++; continue; }
      const meta = ii.extmetadata || {};
      const license = stripTags(meta.LicenseShortName && meta.LicenseShortName.value);
      if (!FREE_LICENSE.test(license)) { why.license++; continue; }
      const artist = stripTags(meta.Artist && meta.Artist.value).slice(0, 60);
      found.push({ file: n, thumb: ii.thumburl, page: ii.descriptionurl, license, artist, title });
    }
    return { found, why: `${picked.length} checked, rejected ${JSON.stringify(why)}` };
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
    for (const title of PLACES[slug]) {
      try {
        const { found, why } = await candidates(title);
        if (!found.length) { say(`place photo ${slug}: "${title}" has no usable free landscape photo (${why})`); continue; }
        let c = null;
        let buf = null;
        for (const f of found.slice(0, 3)) { // the first that downloads cleanly
          try { buf = await download(f.thumb); c = f; break; } catch (err) { say(`place photo ${slug}: ${f.file} download failed: ${err.message}`); }
        }
        if (!buf) continue;
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, slug + '.jpg.tmp'), buf);
        await fsp.rename(path.join(dir, slug + '.jpg.tmp'), path.join(dir, slug + '.jpg'));
        const credit = `Photo: ${c.artist || 'Wikimedia Commons'} · ${c.license}`;
        await fsp.writeFile(path.join(dir, slug + '.json'), JSON.stringify({ credit, url: c.page, file: c.file, article: c.title }));
        say(`place photo ${slug}: saved ${c.file} from "${c.title}" (${c.license}, ${buf.length} bytes)`);
        return true;
      } catch (err) {
        say(`place photo ${slug}: "${title}" failed: ${err.message}`);
      }
    }
    return false;
  }

  /** Fetches whatever is missing. Never throws: a failure just keeps the illustration. */
  async function ensureAll() {
    for (const slug of slugs) {
      try {
        await fsp.access(path.join(dir, slug + '.jpg'));
        await fsp.access(path.join(dir, slug + '.json'));
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

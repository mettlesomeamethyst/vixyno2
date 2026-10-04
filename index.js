// Stremio addon: turns a movie/episode into an external link built from its TMDB id.
// Requires Node 18+ (built-in fetch). No npm dependencies.
//
// ============================ SETTINGS ============================
// Replace the domain below (appears ONLY on the next line, no https://, no trailing slash).
const DOMAIN = 'vixsrc.to';

// Android package of the browser that should open the link.
const BROWSER_PACKAGE = 'com.tcl.browser';
// ==================================================================

// Env vars:
//   TMDB_API_KEY   TMDB v3 API key OR v4 "read access token"  (required for tt... ids)
//   PORT           default 7000

const http = require('http');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_API_KEY || '';

const manifest = {
  id: 'community.tmdb.external.link',
  version: '1.0.0',
  name: 'TMDB External Link',
  description: `Opens the title on ${DOMAIN} using its TMDB id`,
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb'],
  catalogs: [],
};

const cache = new Map(); // "type:imdbId" -> tmdbId

async function imdbToTmdb(imdbId, type) {
  const key = `${type}:${imdbId}`;
  if (cache.has(key)) return cache.get(key);
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY is not set');

  const isV4 = TMDB_KEY.startsWith('eyJ');
  const url = new URL(`https://api.themoviedb.org/3/find/${imdbId}`);
  url.searchParams.set('external_source', 'imdb_id');
  if (!isV4) url.searchParams.set('api_key', TMDB_KEY);

  const res = await fetch(url, isV4 ? { headers: { Authorization: `Bearer ${TMDB_KEY}` } } : {});
  if (!res.ok) throw new Error(`TMDB responded ${res.status}`);
  const data = await res.json();
  const results = type === 'movie' ? data.movie_results : data.tv_results;
  const tmdbId = results && results[0] && results[0].id;
  if (tmdbId) cache.set(key, tmdbId);
  return tmdbId || null;
}

// Stremio ids: movie "tt0133093" | "tmdb:603"; series "tt0413573:2:5" | "tmdb:1416:2:5"
async function buildLink(type, rawId) {
  const parts = rawId.split(':');
  let tmdbId, season, episode;

  if (parts[0] === 'tmdb') {
    tmdbId = parts[1];
    [season, episode] = [parts[2], parts[3]];
  } else {
    tmdbId = await imdbToTmdb(parts[0], type);
    [season, episode] = [parts[1], parts[2]];
  }
  if (!tmdbId) return null;

  if (type === 'movie') return `/movie/${tmdbId}?lang=it`;
  if (!season || !episode) return null;
  return `/tv/${tmdbId}/${season}/${episode}?lang=it`;
}

// Android intent URL that forces a specific app (package) to open the https link.
function intentUrl(path) {
  return `intent://${DOMAIN}${path}#Intent;scheme=https;action=android.intent.action.VIEW;package=${BROWSER_PACKAGE};end`;
}

// ---------- Native playback: read the page's standard HTML5 media tags ----------
// Expected page markup (on YOUR site):
//   <video>
//     <source src="/media/603-en.mp4" type="video/mp4" label="English dub">
//     <source src="/media/603-nl.m3u8" type="application/x-mpegURL" data-lang="nl" label="Nederlands">
//     <track kind="subtitles" src="/subs/603-en.vtt" srclang="en" label="English">
//   </video>
// Each <source> becomes one stream (one per dub); every <track> is attached as a subtitle.

// Stremio prefers 3-letter language codes for subtitles.
const LANG3 = {
  en: 'eng', nl: 'nld', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por',
  ru: 'rus', tr: 'tur', pl: 'pol', ar: 'ara', ja: 'jpn', ko: 'kor', zh: 'zho',
  sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', el: 'ell', he: 'heb', hi: 'hin',
};

function parseAttrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of tag.matchAll(re)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function extractMedia(html, base) {
  const abs = (u) => {
    try {
      const url = new URL(u, base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };
  const looksLikeVideo = (a, url) =>
    /^video\//.test(a.type || '') ||
    /mpegurl/i.test(a.type || '') ||
    /\.(mp4|m3u8|webm|mkv|mov)(\?|#|$)/i.test(url);

  const videos = [];
  for (const m of html.matchAll(/<(?:source|video)\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.src) continue;
    const url = abs(a.src);
    if (!url || !looksLikeVideo(a, url) || videos.some((v) => v.url === url)) continue;
    videos.push({ url, label: a.label || a.title || a['data-label'] || a['data-lang'] || '' });
  }

  const subtitles = [];
  for (const m of html.matchAll(/<track\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.src || (a.kind && !/^(subtitles|captions)$/i.test(a.kind))) continue;
    const url = abs(a.src);
    if (!url || subtitles.some((s) => s.url === url)) continue;
    const code = (a.srclang || '').toLowerCase().split('-')[0];
    subtitles.push({ id: `sub-${subtitles.length + 1}`, url, lang: LANG3[code] || code || a.label || 'und' });
  }
  return { videos, subtitles };
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'stremio-tmdb-link/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return { html: await res.text(), base: res.url };
  } catch (err) {
    console.error(`Could not fetch ${url}: ${err.message}`);
    return null;
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(body));
}

const server = http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const path = decodeURIComponent(req.url.split('?')[0]);

    if (path === '/manifest.json') return send(res, 200, manifest);

    const m = path.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (m) {
      try {
        const path = await buildLink(m[1], m[2]);
        const plain = path && `https://${DOMAIN}${path}`;
        let native = [];
        if (path) {
          const page = await fetchPage(plain);
          if (page) {
            const { videos, subtitles } = extractMedia(page.html, page.base);
            native = videos.map((v, i) => ({
              name: 'Review',
              title: v.label || `Version ${i + 1}`,
              url: v.url,
              subtitles,
            }));
          }
        }
        const streams = path
          ? [
              ...native,
              {
                name: 'TCL Browser',
                title: `Open in ${BROWSER_PACKAGE}\n${plain}`,
                externalUrl: intentUrl(path),
              },
              {
                name: 'Default browser',
                title: `Fallback (https link)\n${plain}`,
                externalUrl: plain,
              },
            ]
          : [];
        return send(res, 200, { streams });
      } catch (err) {
        console.error(err.message);
        return send(res, 200, { streams: [] });
      }
    }
    send(res, 404, { error: 'not found' });
  });

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Addon running: http://localhost:${PORT}/manifest.json  (target: ${DOMAIN})`);
  });
}

module.exports = { extractMedia };

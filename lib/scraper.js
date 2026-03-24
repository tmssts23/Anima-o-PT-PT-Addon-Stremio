const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://tvparapobreskids.com';
const FILMES_ARCHIVE = `${BASE_URL}/filmes/`;
const SERIES_ARCHIVE = `${BASE_URL}/series/`;
const ZETA_API = `${BASE_URL}/wp-json/zetaplayer/v2`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';

const HTTP_TIMEOUT_MS = Math.max(5000, Number(process.env.STREMIO_KIDS_HTTP_TIMEOUT_MS) || 25000);
const CATALOG_CACHE_MS = Math.max(60000, Number(process.env.STREMIO_KIDS_CACHE_MS) || 6 * 60 * 60 * 1000);
const META_CACHE_MS = Math.max(60000, Number(process.env.STREMIO_KIDS_META_CACHE_MS) || CATALOG_CACHE_MS);
const META_TIMEOUT_MS = Math.max(2500, Number(process.env.STREMIO_KIDS_META_TIMEOUT_MS) || 9000);
const META_RETRIES = Math.max(1, Number(process.env.STREMIO_KIDS_META_RETRIES) || 2);
const ARCHIVE_MAX_PAGES = Math.max(1, Number(process.env.STREMIO_KIDS_MAX_ARCHIVE_PAGES) || 500);
const ARCHIVE_CONCURRENCY = Math.max(1, Number(process.env.STREMIO_KIDS_ARCHIVE_CONCURRENCY) || 10);

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN']);
const RETRYABLE_STATUS = new Set([403, 429, 502, 503, 504]);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const client = axios.create({
  baseURL: BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    Referer: `${BASE_URL}/`,
  },
  validateStatus: () => true,
});

const zetaClient = axios.create({
  baseURL: ZETA_API,
  timeout: Math.min(120000, Math.max(12000, HTTP_TIMEOUT_MS)),
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Referer: `${BASE_URL}/`,
  },
  validateStatus: () => true,
});

let filmesCache = null;
let seriesCache = null;
const movieMetaCache = new Map();
const seriesMetaCache = new Map();

function clone(obj) {
  if (obj == null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function normalizeSlug(s) {
  return String(s || '')
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function absoluteUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/${raw}`;
}

function toTitleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function normalizeSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function yearFromText(text) {
  const m = String(text || '').match(/\b((?:19|20)\d{2})\b/);
  if (!m) return undefined;
  const y = parseInt(m[1], 10);
  if (!Number.isFinite(y) || y < 1870 || y > 2100) return undefined;
  return y;
}

function parseImdbRating(text, html) {
  const raw = `${String(text || '')}\n${String(html || '')}`;
  const m = raw.match(/IMDb(?:\s*Rating)?\s*[:\-]?\s*([0-9](?:[.,][0-9])?)/i);
  if (!m || !m[1]) return undefined;
  const n = parseFloat(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10) return undefined;
  return n.toFixed(1);
}

function extractArchiveMaxPage($, html) {
  let max = 1;
  const lastHref = $('link[rel="last"]').attr('href');
  if (lastHref) {
    const m = String(lastHref).match(/\/page\/(\d+)\/?/i);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 1);
  }
  $('a.page-numbers, a.page-number').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  });
  const re = /\/page\/(\d+)\/?/gi;
  let m;
  while ((m = re.exec(String(html || ''))) != null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return Math.max(1, Math.min(max, ARCHIVE_MAX_PAGES));
}

async function safeClientGet(path, retries = 3, timeoutMs = HTTP_TIMEOUT_MS) {
  const n = Math.max(1, retries);
  for (let i = 1; i <= n; i++) {
    try {
      const res = await client.get(path, { timeout: timeoutMs });
      if (res.status === 200) return res;
      if (RETRYABLE_STATUS.has(res.status) && i < n) {
        await new Promise((r) => setTimeout(r, 500 * i));
        continue;
      }
      return res;
    } catch (e) {
      const code = e && (e.code || e.cause?.code);
      if (i < n && RETRYABLE_CODES.has(code)) {
        await new Promise((r) => setTimeout(r, 500 * i));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function poolMap(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  async function runOne() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runOne()));
  return out;
}

function parseDisplayItems($, contentType) {
  const seg = contentType === 'movie' ? 'filmes' : 'series';
  const map = new Map();

  $('.display-item .item-box, article, .post, .entry').each((_, box) => {
    const $box = $(box);
    const href = $box.find('a[href]').first().attr('href');
    if (!href) return;
    let pathname = '';
    try {
      pathname = new URL(absoluteUrl(href)).pathname;
    } catch (_) {
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    const i = parts.indexOf(seg);
    if (i < 0 || !parts[i + 1]) return;
    const slug = normalizeSlug(parts[i + 1]);
    if (!slug || slug === 'page' || slug === 'feed') return;

    const img = $box.find('img').first();
    const poster = absoluteUrl(
      img.attr('data-original') || img.attr('data-src') || img.attr('src') || '',
    );
    const name = toTitleCase(
      (img.attr('alt') || '').trim() ||
        $box.find('h2, h3, .entry-title, .item-desc-title').first().text().trim() ||
        slug.replace(/-/g, ' '),
    );
    const id = contentType === 'movie' ? `kidspt_movie_${slug}` : `kidspt_series_${slug}`;
    map.set(`${contentType}:${slug}`, {
      id,
      slug,
      type: contentType,
      name,
      poster: poster || undefined,
      genres: ['Animação'],
    });
  });

  return [...map.values()];
}

function catalogLog(contentType, msg) {
  const label = contentType === 'movie' ? 'filmes' : 'series';
  console.log(`[KidsPT][catalog:${label}] ${msg}`);
}

async function fetchCatalog(startUrl, contentType) {
  const firstPath = startUrl.startsWith(BASE_URL) ? startUrl.slice(BASE_URL.length) : startUrl;
  const first = await safeClientGet(firstPath || '/', 3, HTTP_TIMEOUT_MS);
  if (!first || first.status !== 200 || typeof first.data !== 'string') return [];

  const firstItems = parseDisplayItems(cheerio.load(first.data), contentType);
  const hintedMaxPage = extractArchiveMaxPage(cheerio.load(first.data), first.data);

  catalogLog(contentType, `Passo 1/2: descobrir total de paginas em ${startUrl}`);
  catalogLog(contentType, `Pagina 1: ${firstItems.length} itens`);
  catalogLog(contentType, `Paginacao visivel no HTML sugere ate ${hintedMaxPage} paginas`);

  let discoveredMaxPage = firstItems.length ? 1 : 0;
  let consecutiveMisses = 0;
  const probeLimit = Math.min(ARCHIVE_MAX_PAGES, Math.max(hintedMaxPage + 2, 3));

  for (let p = 2; p <= probeLimit; p++) {
    const url = `${startUrl.replace(/\/$/, '')}/page/${p}/`;
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const res = await safeClientGet(path, 2, HTTP_TIMEOUT_MS);
    if (!res || res.status !== 200 || typeof res.data !== 'string') {
      consecutiveMisses += 1;
      catalogLog(contentType, `Sondagem pagina ${p}: sem conteudo (status ${res?.status || 'erro'})`);
    } else {
      const count = parseDisplayItems(cheerio.load(res.data), contentType).length;
      if (count > 0) {
        discoveredMaxPage = p;
        consecutiveMisses = 0;
        catalogLog(contentType, `Sondagem pagina ${p}: encontrada (${count} itens)`);
      } else {
        consecutiveMisses += 1;
        catalogLog(contentType, `Sondagem pagina ${p}: vazia`);
      }
    }

    // Stop after two consecutive misses once we are beyond any known page hints.
    if (p > hintedMaxPage && consecutiveMisses >= 2) break;
  }

  if (discoveredMaxPage <= 0) discoveredMaxPage = 1;
  catalogLog(contentType, `Total de paginas encontradas: ${discoveredMaxPage}`);
  catalogLog(contentType, `Passo 2/2: recolher itens de cada pagina`);

  const dedupe = new Map();
  for (let p = 1; p <= discoveredMaxPage; p++) {
    let pageItems = [];
    if (p === 1) {
      pageItems = firstItems;
    } else {
      const url = `${startUrl.replace(/\/$/, '')}/page/${p}/`;
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const res = await safeClientGet(path, 2, HTTP_TIMEOUT_MS);
      if (!res || res.status !== 200 || typeof res.data !== 'string') {
        catalogLog(contentType, `Leitura pagina ${p}/${discoveredMaxPage}: falhou (status ${res?.status || 'erro'})`);
        continue;
      }
      pageItems = parseDisplayItems(cheerio.load(res.data), contentType);
    }
    catalogLog(contentType, `Leitura pagina ${p}/${discoveredMaxPage}: ${pageItems.length} itens`);
    for (const it of pageItems) dedupe.set(it.id, it);
  }
  catalogLog(contentType, `Total de itens unicos no catalogo: ${dedupe.size}`);

  return [...dedupe.values()];
}

async function getFilmes() {
  if (filmesCache && Date.now() - filmesCache.time < CATALOG_CACHE_MS) return filmesCache.items;
  const items = await fetchCatalog(FILMES_ARCHIVE, 'movie');
  if (items.length) filmesCache = { time: Date.now(), items };
  return items.length ? items : filmesCache?.items || [];
}

async function getSeriesPortuguesas() {
  if (seriesCache && Date.now() - seriesCache.time < CATALOG_CACHE_MS) return seriesCache.items;
  const items = await fetchCatalog(SERIES_ARCHIVE, 'series');
  if (items.length) seriesCache = { time: Date.now(), items };
  return items.length ? items : seriesCache?.items || [];
}

function extractSynopsis($) {
  const block = normalizeSpace($('.details-desc').first().text());
  if (block) {
    const fromResumo =
      block.match(/Resumo do Filme:\s*(.+)$/i) ||
      block.match(/Resumo da S[ée]rie:\s*(.+)$/i) ||
      block.match(/Resumo:\s*(.+)$/i) ||
      block.match(/Sinopse:\s*(.+)$/i);
    if (fromResumo && fromResumo[1]) {
      const clean = normalizeSpace(fromResumo[1]);
      if (clean.length > 20) return clean.slice(0, 4500);
    }
    if (block.length > 20) return block.slice(0, 4500);
  }
  const alt = normalizeSpace($('.entry-content, .content, .single-desc, .description').first().text());
  return alt ? alt.slice(0, 4500) : undefined;
}

function blockText($) {
  return normalizeSpace($('.details-desc').first().text() || '');
}

function releaseInfoFromBlock(block) {
  const src = normalizeSpace(block);
  if (!src) return undefined;
  const period = src.match(/(?:Per[ií]odo|Anos?)\s*:\s*([^|]+)$/i);
  if (period && period[1]) return normalizeSpace(period[1]).slice(0, 40);
  const year = yearFromText(src);
  if (year) return String(year);
  return undefined;
}

function extractYoutubeIdFromText(text) {
  const src = String(text || '');
  const patterns = [
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function extractYoutubeTrailerId($, html) {
  const attrs = [
    'iframe[src*="youtube.com"], iframe[src*="youtu.be"]',
    'a[href*="youtube.com/watch"], a[href*="youtu.be/"]',
    '[data-video], [data-src], [data-url], [data-trailer]',
  ];
  for (const sel of attrs) {
    let found;
    $(sel).each((_, el) => {
      if (found) return;
      const $el = $(el);
      const raw =
        $el.attr('src') ||
        $el.attr('href') ||
        $el.attr('data-video') ||
        $el.attr('data-src') ||
        $el.attr('data-url') ||
        $el.attr('data-trailer') ||
        '';
      const id = extractYoutubeIdFromText(raw);
      if (id) found = id;
    });
    if (found) return found;
  }
  return extractYoutubeIdFromText(html);
}

function detailPaths(slug, preferMovie) {
  const s = normalizeSlug(slug);
  const f = [`/filmes/${s}/`, `/filmes/${s}`, `/filme/${s}/`, `/filme/${s}`];
  const r = [`/series/${s}/`, `/series/${s}`, `/serie/${s}/`, `/serie/${s}`];
  return preferMovie ? [...f, ...r] : [...r, ...f];
}

async function fetchDetail(slug, preferMovie) {
  const paths = detailPaths(slug, preferMovie);
  for (const p of paths) {
    const res = await safeClientGet(p, META_RETRIES, META_TIMEOUT_MS);
    if (res && res.status === 200 && typeof res.data === 'string') return { path: p, html: res.data };
  }
  return null;
}

async function findCatalogItem(kind, slug) {
  const s = normalizeSlug(slug);
  const lists = kind === 'movie' ? [await getFilmes()] : [await getSeriesPortuguesas()];
  for (const arr of lists) {
    const hit = arr.find((x) => normalizeSlug(x.slug) === s);
    if (hit) return clone(hit);
  }
  return null;
}

function shellMovieMetaFromStremioId(decoded) {
  const id = String(decoded || '');
  if (!id.startsWith('kidspt_movie_')) return null;
  const slug = normalizeSlug(id.slice('kidspt_movie_'.length));
  if (!slug) return null;
  return {
    id,
    type: 'movie',
    slug,
    name: toTitleCase(slug.replace(/-/g, ' ')),
    description: 'Meta temporaria. O site de origem nao respondeu para este titulo.',
    genres: ['Animação'],
  };
}

function shellSeriesMetaFromStremioId(decoded) {
  const full = String(decoded || '');
  if (!full.startsWith('kidspt_series_')) return null;
  const m = full.match(/^kidspt_series_(.+):\d+:\d+$/);
  const id = m ? `kidspt_series_${m[1]}` : full;
  const slug = normalizeSlug(id.slice('kidspt_series_'.length));
  if (!slug) return null;
  return {
    id,
    type: 'series',
    slug,
    name: toTitleCase(slug.replace(/-/g, ' ')),
    description: 'Meta temporaria. O site de origem nao respondeu para esta serie.',
    genres: ['Animação'],
    episodes: [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }],
  };
}

function remapEpisodes(raw) {
  const ssids = [...new Set(raw.map((e) => e.rawSsid))].sort((a, b) => a - b);
  const map = new Map(ssids.map((id, i) => [id, i + 1]));
  return raw
    .map((e) => ({ season: map.get(e.rawSsid), episode: e.episode, wpPid: e.wpPid, name: e.name }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

async function getFilmeMeta(slug) {
  const key = normalizeSlug(slug);
  const c = movieMetaCache.get(key);
  if (c && Date.now() - c.time < META_CACHE_MS) return clone(c.item);

  const fetched = await fetchDetail(slug, true);
  if (!fetched) {
    const fallback = await findCatalogItem('movie', slug);
    if (fallback) {
      const item = { ...fallback, type: 'movie', genres: fallback.genres || ['Animação'] };
      movieMetaCache.set(key, { time: Date.now(), item: clone(item) });
      return item;
    }
    return c?.item ? clone(c.item) : null;
  }

  const { html, path } = fetched;
  const $ = cheerio.load(html);
  const slugFromPath = normalizeSlug(path.split('/').filter(Boolean).pop());
  const canonicalSlug = slugFromPath || key;
  const name = toTitleCase(
    $('h1').first().text().trim() || $('.display-page-heading h1').first().text().trim() || canonicalSlug.replace(/-/g, ' '),
  );
  const details = blockText($);
  const year = yearFromText(`${details} ${$('body').text()}`) || yearFromText($('h1').first().text());
  const bodyTxt = $('body').text();
  const imdbM =
    $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) ||
    bodyTxt.match(/IMDb(?:\s*ID|\s*:\s*|\s+)(tt\d{7,9})/i);
  const item = {
    id: `kidspt_movie_${canonicalSlug}`,
    type: 'movie',
    slug: canonicalSlug,
    name,
    description: extractSynopsis($),
    year,
    releaseInfo: releaseInfoFromBlock(details) || (year ? String(year) : undefined),
    runtime: undefined,
    genres: ['Animação'],
    poster: absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '') || undefined,
    imdbId: imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined,
    imdbRating: parseImdbRating(bodyTxt, html),
    trailerYtId: extractYoutubeTrailerId($, html),
    wpPostId:
      parseInt(($.html().match(/[?&]p=(\d+)/)?.[1]) || '', 10) ||
      parseInt($('.zetaflix_player_option').first().attr('data-post') || '', 10) ||
      undefined,
  };
  movieMetaCache.set(key, { time: Date.now(), item: clone(item) });
  movieMetaCache.set(canonicalSlug, { time: Date.now(), item: clone(item) });
  return clone(item);
}

async function getSeriesMeta(slug) {
  const key = normalizeSlug(slug);
  const c = seriesMetaCache.get(key);
  if (c && Date.now() - c.time < META_CACHE_MS) return clone(c.item);

  const fetched = await fetchDetail(slug, false);
  if (!fetched) {
    const fallback = await findCatalogItem('series', slug);
    if (fallback) {
      const item = {
        ...fallback,
        type: 'series',
        genres: fallback.genres || ['Animação'],
        episodes: [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }],
      };
      seriesMetaCache.set(key, { time: Date.now(), item: clone(item) });
      return item;
    }
    return c?.item ? clone(c.item) : null;
  }

  const { html, path } = fetched;
  const $ = cheerio.load(html);
  const slugFromPath = normalizeSlug(path.split('/').filter(Boolean).pop());
  const canonicalSlug = slugFromPath || key;
  const name = toTitleCase(
    $('h1').first().text().trim() || $('.display-page-heading h1').first().text().trim() || canonicalSlug.replace(/-/g, ' '),
  );
  const details = blockText($);
  const year = yearFromText(`${details} ${$('body').text()}`) || yearFromText($('h1').first().text());
  const bodyTxt = $('body').text();
  const imdbM =
    $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) ||
    bodyTxt.match(/IMDb(?:\s*ID|\s*:\s*|\s+)(tt\d{7,9})/i);

  const rawEpisodes = [];
  $('.play-ep').each((_, el) => {
    const $el = $(el);
    const wpPid = parseInt($el.attr('data-pid') || '', 10);
    const ep = parseInt($el.attr('data-epid') || '', 10);
    const ssid = parseInt($el.attr('data-ssid') || '', 10);
    if (!Number.isFinite(wpPid) || wpPid <= 0) return;
    if (!Number.isFinite(ep) || ep <= 0) return;
    if (!Number.isFinite(ssid) || ssid <= 0) return;
    const title = $el.find('.ep-title').first().text().trim() || `Episodio ${ep}`;
    if (!rawEpisodes.some((e) => e.rawSsid === ssid && e.episode === ep)) {
      rawEpisodes.push({ rawSsid: ssid, episode: ep, wpPid, name: title });
    }
  });
  let episodes = remapEpisodes(rawEpisodes);
  if (!episodes.length) episodes = [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }];

  const item = {
    id: `kidspt_series_${canonicalSlug}`,
    type: 'series',
    slug: canonicalSlug,
    name,
    description: extractSynopsis($),
    year,
    releaseInfo: releaseInfoFromBlock(details) || (year ? String(year) : undefined),
    runtime: undefined,
    genres: ['Animação'],
    poster: absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '') || undefined,
    imdbId: imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined,
    imdbRating: parseImdbRating(bodyTxt, html),
    trailerYtId: extractYoutubeTrailerId($, html),
    episodes,
  };
  seriesMetaCache.set(key, { time: Date.now(), item: clone(item) });
  seriesMetaCache.set(canonicalSlug, { time: Date.now(), item: clone(item) });
  return clone(item);
}

async function getMovieStreamSources(wpPostId) {
  if (!wpPostId) return [];
  const out = [];
  const seen = new Set();
  for (let n = 1; n <= 30; n++) {
    let res;
    try {
      res = await zetaClient.get(`/${wpPostId}/mv/${n}`);
    } catch (_) {
      break;
    }
    if (res.status !== 200 || !res.data) break;
    const u0 = String(res.data.embed_url || '').trim();
    if (!u0) {
      if (res.data.type === false) break;
      continue;
    }
    let u = u0.startsWith('//') ? `https:${u0}` : u0;
    u = u.replace(/^http:\/\//i, 'https://');
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'url', title: `Opcao ${out.length + 1}`, url: u });
  }
  return out;
}

async function getTvEpisodeStreamSources(wpEpisodePid) {
  if (!wpEpisodePid) return [];
  let res;
  try {
    res = await zetaClient.get(`/tvep/${wpEpisodePid}`);
  } catch (_) {
    return [];
  }
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.embed)) return [];
  const out = [];
  const seen = new Set();
  for (const row of res.data.embed) {
    const u0 = String(row.code || '').trim();
    if (!u0) continue;
    let u = u0.startsWith('//') ? `https:${u0}` : u0;
    u = u.replace(/^http:\/\//i, 'https://');
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'url', title: row.name || row.title || `Opcao ${out.length + 1}`, url: u });
  }
  return out;
}

module.exports = {
  BASE_URL,
  getFilmes,
  getSeriesPortuguesas,
  getFilmeMeta,
  getSeriesMeta,
  getMovieStreamSources,
  getTvEpisodeStreamSources,
  shellMovieMetaFromStremioId,
  shellSeriesMetaFromStremioId,
};

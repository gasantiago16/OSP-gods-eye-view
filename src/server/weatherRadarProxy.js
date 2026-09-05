/**
 * Same-origin RainViewer radar catalog + tile proxy.
 *
 * The browser never chooses an upstream URL. Catalog paths stay on the server.
 * Tiles are fetched only for advertised frames, zoom ≤ 7, and allowlisted hosts.
 */

import {
  admitRadarFrames,
  isRadarFrameId,
  isValidRadarTileCoord,
  MAX_RADAR_ZOOM,
  PUBLIC_TILE_TEMPLATE,
} from '../weather/timeline.js';

export const RAINVIEWER_CATALOG_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const ALLOWED_TILE_ORIGINS = Object.freeze([
  'https://tilecache.rainviewer.com',
  'https://tilecache2.rainviewer.com',
]);
export const RADAR_TILE_SIZE = 256;
export const RADAR_COLOR_SCHEME = 2;
export const RADAR_TILE_OPTIONS = '1_0';
export const RADAR_UPSTREAM_TIMEOUT_MS = 8_000;
export const RADAR_MAX_CONCURRENT_TILES = 6;
export const RADAR_UPSTREAM_PER_MINUTE = 100;
export const RADAR_TILE_CACHE_ENTRIES = 128;
export const RADAR_TILE_CACHE_BYTES = 64 * 1024 * 1024;
export const RADAR_CATALOG_TTL_MS = 30_000;

const TILE_PATH = /^\/tiles\/(\d{9,10})\/(\d{1,2})\/(\d{1,4})\/(\d{1,4})\.png$/;

function defaultSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

/** @param {unknown} host */
export function normalizeTileHost(host) {
  const text = String(host || '').trim().replace(/\/+$/, '');
  return ALLOWED_TILE_ORIGINS.includes(text) ? text : null;
}

/**
 * @param {string} pathname
 * @returns {{ frame: string, z: number, x: number, y: number }|{ error: string }|null}
 */
export function parseRadarTilePath(pathname) {
  const match = TILE_PATH.exec(String(pathname || ''));
  if (!match) return null;
  const frame = match[1];
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  if (!isRadarFrameId(frame)) return { error: 'frame', frame, z, x, y };
  if (!Number.isInteger(z) || z > MAX_RADAR_ZOOM || z < 0) return { error: 'zoom', frame, z, x, y };
  if (!isValidRadarTileCoord(z, x, y)) return { error: 'xyz', frame, z, x, y };
  return { frame, z, x, y };
}

export function radarTileUpstreamUrl(host, path, z, x, y) {
  return `${host}${path}/${RADAR_TILE_SIZE}/${z}/${x}/${y}/${RADAR_COLOR_SCHEME}/${RADAR_TILE_OPTIONS}.png`;
}

/**
 * Public catalog the browser may see. Upstream host/path stay server-side.
 * @param {object|null} upstream
 * @param {{ now?: number, retrievedAt?: string, catalogStatus?: string }} [options]
 */
export function buildPublicCatalog(upstream, {
  now = Date.now(),
  retrievedAt = null,
  catalogStatus = null,
} = {}) {
  const host = normalizeTileHost(upstream?.host);
  const frames = host ? admitRadarFrames(upstream?.radar?.past) : [];
  const ready = Boolean(host && frames.length);
  const status = catalogStatus || (ready ? 'ready' : 'unavailable');
  return {
    productId: 'rainviewer-radar',
    kind: 'radar',
    maxZoom: MAX_RADAR_ZOOM,
    attribution: 'https://www.rainviewer.com/',
    retrievedAt: retrievedAt || new Date(now).toISOString(),
    catalogStatus: status,
    colorScheme: 'universal-blue',
    coverageNote: 'No color does not mean no rain. Coverage is not global. Max zoom 7.',
    frames: frames.map((frame) => ({ id: frame.id, validTime: frame.validTime })),
    tileTemplate: PUBLIC_TILE_TEMPLATE,
  };
}

/** Server-only frame map: id → { host, path, validTime }. */
export function buildFrameIndex(upstream) {
  const host = normalizeTileHost(upstream?.host);
  if (!host) return new Map();
  const frames = admitRadarFrames(upstream?.radar?.past);
  return new Map(frames.map((frame) => [frame.id, { host, path: frame.path, validTime: frame.validTime }]));
}

function createByteLru({ maxEntries = RADAR_TILE_CACHE_ENTRIES, maxBytes = RADAR_TILE_CACHE_BYTES } = {}) {
  const entries = new Map();
  let bytes = 0;

  function evictIfNeeded(incomingBytes) {
    while (
      entries.size >= maxEntries
      || bytes + incomingBytes > maxBytes
    ) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = entries.get(oldest);
      entries.delete(oldest);
      bytes -= removed?.bytes || 0;
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, value) {
      const nextBytes = value.bytes || 0;
      const existing = entries.get(key);
      if (existing) {
        bytes -= existing.bytes || 0;
        entries.delete(key);
      }
      if (nextBytes > maxBytes) return false;
      evictIfNeeded(nextBytes);
      entries.set(key, value);
      bytes += nextBytes;
      return true;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
}

function createMinuteGovernor(limit = RADAR_UPSTREAM_PER_MINUTE) {
  const hits = [];
  return {
    tryAcquire(now) {
      const cutoff = now - 60_000;
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(now);
      return true;
    },
  };
}

function createConcurrencyGate(max = RADAR_MAX_CONCURRENT_TILES) {
  let active = 0;
  const waiting = [];
  return async function run(work) {
    if (active >= max) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendPng(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'image/png',
    'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function normalizePathname(rawUrl) {
  const url = new URL(String(rawUrl || '/'), 'http://internal');
  let pathname = url.pathname || '/';
  if (pathname.startsWith('/api/weather-radar')) {
    pathname = pathname.slice('/api/weather-radar'.length) || '/';
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return { url, pathname };
}

/**
 * @param {object} [options]
 * @returns {{ middleware: Function, inspect: Function }}
 */
export function createWeatherRadarProxy({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  makeSignal = defaultSignal,
  catalogUrl = RAINVIEWER_CATALOG_URL,
  catalogTtlMs = RADAR_CATALOG_TTL_MS,
  timeoutMs = RADAR_UPSTREAM_TIMEOUT_MS,
} = {}) {
  const tileCache = createByteLru();
  const governor = createMinuteGovernor();
  const tileGate = createConcurrencyGate();
  /** @type {{ at: number, upstream: object, publicCatalog: object, frames: Map<string, object>, stale: boolean }|null} */
  let catalog = null;
  let catalogInflight = null;

  async function fetchUpstreamCatalog() {
    const signal = makeSignal(timeoutMs);
    const response = await fetchImpl(catalogUrl, signal ? { signal } : {});
    if (!response.ok) {
      const error = new Error(`RainViewer catalog HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    const frames = buildFrameIndex(json);
    const publicCatalog = buildPublicCatalog(json, { now: now() });
    if (publicCatalog.catalogStatus !== 'ready') {
      const error = new Error('RainViewer catalog missing host or frames');
      error.status = 502;
      throw error;
    }
    catalog = {
      at: now(),
      upstream: json,
      publicCatalog,
      frames,
      stale: false,
    };
    return catalog;
  }

  async function loadCatalog({ allowStale = true } = {}) {
    const current = now();
    if (catalog && current - catalog.at < catalogTtlMs && !catalog.stale) return catalog;
    if (catalogInflight) return catalogInflight;
    catalogInflight = fetchUpstreamCatalog()
      .catch((error) => {
        if (allowStale && catalog?.frames?.size) {
          catalog = {
            ...catalog,
            stale: true,
            publicCatalog: {
              ...catalog.publicCatalog,
              catalogStatus: 'stale',
            },
          };
          return catalog;
        }
        throw error;
      })
      .finally(() => {
        catalogInflight = null;
      });
    return catalogInflight;
  }

  async function proxyTile(frameMeta, z, x, y) {
    const cacheKey = `${frameMeta.path}:${z}:${x}:${y}`;
    const cached = tileCache.get(cacheKey);
    if (cached) return { status: 200, body: cached.body, cache: 'HIT' };

    const stamp = now();
    if (!governor.tryAcquire(stamp)) {
      const error = new Error('RainViewer rate limited');
      error.status = 429;
      throw error;
    }

    return tileGate(async () => {
      const again = tileCache.get(cacheKey);
      if (again) return { status: 200, body: again.body, cache: 'HIT' };
      const upstreamUrl = radarTileUpstreamUrl(frameMeta.host, frameMeta.path, z, x, y);
      const signal = makeSignal(timeoutMs);
      const response = await fetchImpl(upstreamUrl, signal ? { signal } : {});
      if (!response.ok) {
        const error = new Error(`RainViewer tile HTTP ${response.status}`);
        error.status = response.status >= 500 ? 502 : response.status;
        error.retryable = false;
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      tileCache.set(cacheKey, { body: buffer, bytes: buffer.byteLength, at: now() });
      return { status: 200, body: buffer, cache: 'MISS' };
    });
  }

  async function middleware(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const { pathname } = normalizePathname(req.url);
    try {
      if (pathname === '/catalog' || pathname === '/') {
        const loaded = await loadCatalog();
        sendJson(res, 200, loaded.publicCatalog);
        return;
      }
      const tile = parseRadarTilePath(pathname);
      if (!tile) {
        sendJson(res, 404, { error: 'Unknown weather-radar route' });
        return;
      }
      if (tile.error === 'zoom') {
        sendJson(res, 400, { error: `zoom ${tile.z} exceeds max ${MAX_RADAR_ZOOM}` });
        return;
      }
      if (tile.error) {
        sendJson(res, 400, { error: `invalid radar tile ${tile.error}` });
        return;
      }
      const loaded = await loadCatalog();
      const frameMeta = loaded.frames.get(tile.frame);
      if (!frameMeta) {
        sendJson(res, 400, { error: 'unknown radar frame' });
        return;
      }
      const tileResult = await proxyTile(frameMeta, tile.z, tile.x, tile.y);
      if (method === 'HEAD') {
        sendPng(res, 200, Buffer.alloc(0), { 'X-Radar-Cache': tileResult.cache });
        return;
      }
      sendPng(res, 200, tileResult.body, { 'X-Radar-Cache': tileResult.cache });
    } catch (error) {
      const status = Number(error?.status);
      if (status === 429) {
        sendJson(res, 429, { error: 'Rate limit exceeded' });
        return;
      }
      if (status === 400) {
        sendJson(res, 400, { error: error.message || 'Bad radar request' });
        return;
      }
      if (catalog?.publicCatalog && pathname === '/catalog') {
        sendJson(res, 200, catalog.publicCatalog);
        return;
      }
      sendJson(res, status >= 400 && status < 600 ? status : 502, {
        error: error?.message || 'Weather radar upstream error',
      });
    }
  }

  return {
    middleware,
    inspect: () => ({
      catalog,
      tileCacheSize: tileCache.size,
      tileCacheBytes: tileCache.bytes,
    }),
  };
}

export function weatherRadarProxyPlugin(options = {}) {
  const proxy = createWeatherRadarProxy(options);
  const install = (server) => {
    server.middlewares.use('/api/weather-radar', proxy.middleware);
  };
  return {
    name: 'weather-radar-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

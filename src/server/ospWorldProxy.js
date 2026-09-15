/**
 * Same-origin World Track bridge.
 *
 * GEV never talks to :8765 from the browser. Only allowlisted weather/health
 * routes forward to a loopback World Track origin. Arbitrary paths are 404.
 */

export const DEFAULT_WORLD_TRACK_ORIGIN = 'http://127.0.0.1:8765';
export const OSP_WORLD_TIMEOUT_MS = 8_000;
export const ACK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeWorldTrackOrigin(raw = DEFAULT_WORLD_TRACK_ORIGIN) {
  try {
    const url = new URL(String(raw || DEFAULT_WORLD_TRACK_ORIGIN));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {string|null} World Track pathname
 */
export function mapOspWorldPath(method, pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'GET' && path === '/weather') return '/api/weather';
  if (verb === 'GET' && path === '/weather/flags') return '/api/weather/flags';
  if (verb === 'GET' && path === '/health') return '/api/health';
  if (verb === 'POST') {
    const match = /^\/weather\/flags\/([^/]+)\/ack$/.exec(path);
    if (match && ACK_ID.test(match[1])) return `/api/weather/flags/${match[1]}/ack`;
  }
  return null;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createOspWorldProxy({
  origin = DEFAULT_WORLD_TRACK_ORIGIN,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = OSP_WORLD_TIMEOUT_MS,
} = {}) {
  const upstreamOrigin = normalizeWorldTrackOrigin(origin);

  async function middleware(req, res) {
    if (!upstreamOrigin) {
      sendJson(res, 500, { ok: false, error: 'World Track origin is not loopback' });
      return;
    }
    const url = new URL(req.url || '/', 'http://gev.local');
    const mapped = mapOspWorldPath(req.method, url.pathname);
    if (!mapped) {
      sendJson(res, 404, { ok: false, error: 'Unknown osp-world route' });
      return;
    }
    const target = `${upstreamOrigin}${mapped}${url.search}`;
    const headers = { Accept: 'application/json' };
    const init = { method: req.method, headers };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    if (String(req.method).toUpperCase() === 'POST') {
      try {
        init.body = await readBody(req);
      } catch (error) {
        sendJson(res, error.status || 400, { ok: false, error: error.message });
        return;
      }
      headers['Content-Type'] = 'application/json';
    }
    try {
      const response = await fetchImpl(target, init);
      const text = await response.text();
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(text);
    } catch {
      sendJson(res, 503, {
        ok: false,
        catalogStatus: 'unavailable',
        error: 'World Track unreachable',
      });
    }
  }

  return { middleware, origin: upstreamOrigin };
}

export function ospWorldProxyPlugin(options = {}) {
  const proxy = createOspWorldProxy(options);
  const install = (server) => {
    server.middlewares.use('/api/osp-world', proxy.middleware);
  };
  return {
    name: 'osp-world-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

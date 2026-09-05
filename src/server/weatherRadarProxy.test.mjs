import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_TILE_ORIGINS,
  buildFrameIndex,
  buildPublicCatalog,
  createWeatherRadarProxy,
  normalizeTileHost,
  parseRadarTilePath,
  radarTileUpstreamUrl,
} from './weatherRadarProxy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

const UPSTREAM = {
  version: '2.0',
  generated: 1788570625,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1788563400, path: '/v2/radar/7fe2a0a30bbf' },
      { time: 1788564000, path: '/v2/radar/a74f57bb1bb3' },
    ],
    nowcast: [{ time: 1788571200, path: '/v2/radar/nowcast-ignored' }],
  },
  satellite: { infrared: [{ time: 1, path: '/v2/satellite/ir' }] },
};

function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(status, headers = {}) {
        result.status = status;
        result.headers = headers;
      },
      end(body = '') {
        this.headersSent = true;
        result.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        chunks.push(result.body);
        resolve(result);
      },
    };
    Promise.resolve(middleware({ url, method }, res)).catch(reject);
  });
}

function catalogFetch() {
  return new Response(JSON.stringify(UPSTREAM), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('public catalog omits upstream host/path and drops nowcast/IR', () => {
  const published = buildPublicCatalog(UPSTREAM);
  assert.equal(published.productId, 'rainviewer-radar');
  assert.equal(published.maxZoom, 7);
  assert.equal(published.catalogStatus, 'ready');
  assert.deepEqual(published.frames.map((frame) => frame.id), ['1788563400', '1788564000']);
  assert.equal(JSON.stringify(published).includes('tilecache.rainviewer.com'), false);
  assert.equal(JSON.stringify(published).includes('/v2/radar/'), false);
  assert.equal(normalizeTileHost('https://evil.example'), null);
  assert.equal(normalizeTileHost(ALLOWED_TILE_ORIGINS[0]), ALLOWED_TILE_ORIGINS[0]);
  assert.equal(buildFrameIndex({ host: 'https://evil.example', radar: UPSTREAM.radar }).size, 0);
});

test('tile path parser rejects z=8, unknown shape, and out-of-range xyz', () => {
  assert.deepEqual(parseRadarTilePath('/tiles/1788563400/7/1/2.png'), {
    frame: '1788563400', z: 7, x: 1, y: 2,
  });
  assert.equal(parseRadarTilePath('/tiles/1788563400/8/0/0.png').error, 'zoom');
  assert.equal(parseRadarTilePath('/tiles/1788563400/7/128/0.png').error, 'xyz');
  assert.equal(parseRadarTilePath('/tiles/not-a-frame/7/0/0.png'), null);
});

test('catalog route is same-origin JSON and never caches upstream failures as tiles', async () => {
  const calls = [];
  const proxy = createWeatherRadarProxy({
    now: () => 1_000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('weather-maps.json')) return catalogFetch();
      throw new Error('unexpected');
    },
  });
  const result = await invoke(proxy.middleware, '/catalog');
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body.toString());
  assert.equal(body.catalogStatus, 'ready');
  assert.equal(body.frames.length, 2);
  assert.equal(calls.length, 1);
});

test('z=8 and unknown frame are 400; advertised tiles hit the allowlisted host only', async () => {
  const calls = [];
  const proxy = createWeatherRadarProxy({
    now: () => 1_000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('weather-maps.json')) return catalogFetch();
      assert.equal(
        String(url),
        radarTileUpstreamUrl('https://tilecache.rainviewer.com', '/v2/radar/7fe2a0a30bbf', 7, 1, 2),
      );
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  });

  const zoom = await invoke(proxy.middleware, '/tiles/1788563400/8/0/0.png');
  assert.equal(zoom.status, 400);

  const unknown = await invoke(proxy.middleware, '/tiles/1111111111/7/0/0.png');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.toString(), /unknown radar frame/);

  const ok = await invoke(proxy.middleware, '/tiles/1788563400/7/1/2.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Type'], 'image/png');
  assert.deepEqual(ok.body, PNG);

  const cached = await invoke(proxy.middleware, '/tiles/1788563400/7/1/2.png');
  assert.equal(cached.status, 200);
  assert.equal(cached.headers['X-Radar-Cache'], 'HIT');
  assert.equal(calls.filter((url) => url.endsWith('.png')).length, 1);
});

test('4xx/5xx tiles are not stored in the image cache', async () => {
  let tileCalls = 0;
  const proxy = createWeatherRadarProxy({
    now: () => 1_000,
    fetchImpl: async (url) => {
      if (String(url).includes('weather-maps.json')) return catalogFetch();
      tileCalls += 1;
      return new Response('nope', { status: 502 });
    },
  });
  const first = await invoke(proxy.middleware, '/tiles/1788563400/2/0/0.png');
  assert.equal(first.status, 502);
  const second = await invoke(proxy.middleware, '/tiles/1788563400/2/0/0.png');
  assert.equal(second.status, 502);
  assert.equal(tileCalls, 2);
  assert.equal(proxy.inspect().tileCacheSize, 0);
});

test('missing catalog host is unavailable rather than a fabricated tile source', () => {
  const published = buildPublicCatalog({
    host: 'http://tilecache.rainviewer.com',
    radar: { past: UPSTREAM.radar.past },
  });
  assert.equal(published.catalogStatus, 'unavailable');
  assert.equal(published.frames.length, 0);
});

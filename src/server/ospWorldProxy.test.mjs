import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapOspWorldPath,
  normalizeWorldTrackOrigin,
  createOspWorldProxy,
} from './ospWorldProxy.js';

test('World Track origin must be loopback', () => {
  assert.equal(normalizeWorldTrackOrigin('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(normalizeWorldTrackOrigin('http://localhost:8765'), 'http://localhost:8765');
  assert.equal(normalizeWorldTrackOrigin('https://evil.example/weather'), null);
  assert.equal(normalizeWorldTrackOrigin('http://10.0.0.5:8765'), null);
});

test('only weather and health paths map upstream', () => {
  assert.equal(mapOspWorldPath('GET', '/weather'), '/api/weather');
  assert.equal(mapOspWorldPath('GET', '/weather/flags'), '/api/weather/flags');
  assert.equal(
    mapOspWorldPath('POST', '/weather/flags/11111111-1111-1111-1111-111111111111/ack'),
    '/api/weather/flags/11111111-1111-1111-1111-111111111111/ack',
  );
  assert.equal(mapOspWorldPath('GET', '/health'), '/api/health');
  assert.equal(mapOspWorldPath('GET', '/snapshot'), null);
  assert.equal(mapOspWorldPath('GET', '/opensky'), null);
  assert.equal(mapOspWorldPath('POST', '/weather/flags/not-a-uuid/ack'), null);
});

function invoke(middleware, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const req = {
      url,
      method,
      on(event, fn) {
        if (event === 'data') fn(Buffer.from(body));
        if (event === 'end') fn();
      },
      destroy() {},
    };
    const res = {
      writeHead(status, headers = {}) {
        result.status = status;
        result.headers = headers;
      },
      end(payload = '') {
        result.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
        resolve(result);
      },
    };
    Promise.resolve(middleware(req, res)).catch(reject);
  });
}

test('proxy forwards allowlisted GET and 404s the rest', async () => {
  const calls = [];
  const proxy = createOspWorldProxy({
    origin: 'http://127.0.0.1:8765',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, catalogStatus: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const ok = await invoke(proxy.middleware, '/weather?lat=26&lon=-97');
  assert.equal(ok.status, 200);
  assert.equal(calls[0], 'http://127.0.0.1:8765/api/weather?lat=26&lon=-97');
  const denied = await invoke(proxy.middleware, '/snapshot');
  assert.equal(denied.status, 404);
  assert.equal(calls.length, 1);
});

test('unreachable World Track is 503 not SAFE', async () => {
  const proxy = createOspWorldProxy({
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  const result = await invoke(proxy.middleware, '/weather/flags');
  assert.equal(result.status, 503);
  const body = JSON.parse(String(result.body));
  assert.equal(body.catalogStatus, 'unavailable');
});

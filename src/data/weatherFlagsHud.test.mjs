import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatFlagsView,
  statusLine,
  createWeatherFlagsHud,
} from './weatherFlagsHud.js';

test('status line does not treat missing echo as SAFE', () => {
  const view = formatFlagsView({
    weather: {
      catalogStatus: 'ready',
      stale: false,
      points: [{ lat: 26, lon: -97, dbz: null, coverage: 'conus' }],
    },
    flags: { flags: [], disclaimer: 'Not ATC' },
  });
  assert.equal(statusLine(view), 'MRMS READY  ·  NO ECHO  ·  CONUS');
  const unknown = formatFlagsView({
    weather: {
      catalogStatus: 'ready',
      points: [{ lat: 20.9, lon: -156.4, dbz: null, coverage: 'unknown' }],
    },
    flags: { flags: [] },
  });
  assert.match(statusLine(unknown), /UNKNOWN/);
});

test('HUD polls camera LLA and posts ACK', async () => {
  const calls = [];
  const host = {
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      createElement(tag) {
        const node = {
          tagName: tag,
          className: '',
          textContent: '',
          title: '',
          type: '',
          dataset: {},
          children: [],
          append(...kids) { this.children.push(...kids); },
        };
        return node;
      },
    },
  };
  const list = { replaceChildren() { this.children = []; }, children: [], appendChild(n) { this.children.push(n); } };
  const status = { textContent: '' };
  const root = {
    hidden: true,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener() {},
    querySelector(sel) {
      if (sel.includes('status')) return status;
      if (sel.includes('list')) return list;
      return null;
    },
  };
  const hud = createWeatherFlagsHud({
    host,
    getLla: () => ({ lat: 29.98, lon: -99.98 }),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
      if (String(url).includes('/ack')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (String(url).includes('/flags')) {
        return new Response(JSON.stringify({
          ok: true,
          catalogStatus: 'ready',
          disclaimer: 'Not ATC',
          flags: [{
            id: '11111111-1111-1111-1111-111111111111',
            kind: 'WEATHER_CELL',
            severity: 'CAUTION',
            ack: 'pending',
            evidence: { dbz: 35 },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        catalogStatus: 'ready',
        points: [{ lat: 29.98, lon: -99.98, dbz: 35, coverage: 'conus' }],
      }), { status: 200 });
    },
  });
  hud.mount(root);
  await hud.poll();
  assert.equal(root.hidden, false);
  assert.match(hud.getView().catalogStatus, /ready/);
  assert.equal(hud.getView().pending.length, 1);
  assert.ok(calls.some((c) => c.url.includes('/api/osp-world/weather?lat=29.98')));
  assert.ok(calls.some((c) => c.url.includes('twins=true')));
  await root.listeners.click({
    target: { closest: () => ({ dataset: { flagId: '11111111-1111-1111-1111-111111111111', ack: 'acked' } }) },
  });
  assert.ok(calls.some((c) => c.method === 'POST' && String(c.url).includes('/ack')));
  hud.destroy();
});

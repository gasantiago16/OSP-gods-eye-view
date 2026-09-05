import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayerManager, layerFeedState } from './manager.js';
import { createWeatherRadarLayer } from './weatherRadar.js';

const FRAMES = [
  { id: '1788563400', validTime: 1788563400 * 1000 },
  { id: '1788564000', validTime: 1788564000 * 1000 },
  { id: '1788564600', validTime: 1788564600 * 1000 },
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createHost() {
  const listeners = new Map();
  return {
    document: { hidden: false, body: { classList: { contains: () => false } } },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = (listeners.get(type) || []).filter((item) => item !== fn);
      listeners.set(type, list);
    },
    emit(type, detail) {
      for (const fn of listeners.get(type) || []) fn({ detail });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    setTimeout,
    clearTimeout,
  };
}

function createRenderer() {
  const shown = [];
  return {
    attach() {},
    setOpacity() {},
    getOpacity() { return 0.65; },
    activeFrameId() { return shown[shown.length - 1] || null; },
    layerCount() { return shown.length ? 1 : 0; },
    async showFrame(id) { shown.push(id); return true; },
    clear() { shown.length = 0; },
    destroy() { shown.length = 0; },
    shown,
  };
}

function catalogPayload(overrides = {}) {
  return {
    productId: 'rainviewer-radar',
    kind: 'radar',
    catalogStatus: 'ready',
    attribution: 'https://www.rainviewer.com/',
    coverageNote: 'No color does not mean no rain.',
    frames: FRAMES,
    ...overrides,
  };
}

function createLayer(overrides = {}) {
  const host = overrides.host || createHost();
  const renderer = overrides.renderer || createRenderer();
  let stackId = overrides.stackId ?? 'osm';
  const stacks = [];
  const fetches = [];
  const layer = createWeatherRadarLayer({
    renderer,
    host,
    now: overrides.now || (() => FRAMES[2].validTime + 60_000),
    getActiveStackId: () => stackId,
    setMapStack: async (id) => {
      stacks.push(id);
      stackId = id;
      return { ok: true, activeStack: id };
    },
    fetchImpl: async (url) => {
      fetches.push(String(url));
      if (overrides.fetchImpl) return overrides.fetchImpl(url, fetches);
      return jsonResponse(catalogPayload());
    },
    playbackMs: overrides.playbackMs || 10,
    requestRender: () => {},
  });
  return {
    layer,
    host,
    renderer,
    fetches,
    stacks,
    setStack: (id) => { stackId = id; },
    getStack: () => stackId,
  };
}

test('radar stays off until enable and then paints the latest advertised frame', async () => {
  const world = createLayer();
  world.layer.init({});
  assert.equal(world.layer.getStats().status, 'off');
  assert.equal(world.fetches.length, 0);
  await world.layer.enable();
  assert.equal(world.fetches[0], '/api/weather-radar/catalog');
  assert.equal(world.renderer.shown.at(-1), '1788564600');
  assert.equal(world.layer.getStats().status, 'latest');
  assert.equal(world.layer.getStats().countLabel, '1 MIN');
  await world.layer.disable();
  assert.equal(world.renderer.shown.length, 0);
  assert.equal(world.layer.getStats().status, 'off');
});

test('enable on photoreal switches to OSM and disable restores it', async () => {
  const world = createLayer({ stackId: 'photoreal' });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, ['osm']);
  assert.equal(world.getStack(), 'osm');
  assert.equal(world.renderer.shown.at(-1), '1788564600');
  await world.layer.disable();
  assert.deepEqual(world.stacks, ['osm', 'photoreal']);
});

test('a later photoreal choice suspends tiles instead of painting a hidden globe', async () => {
  const world = createLayer({ stackId: 'osm' });
  world.layer.init({});
  await world.layer.enable();
  world.setStack('photoreal');
  world.host.emit('gev:map-stack-changed', { activeId: 'photoreal' });
  assert.equal(world.layer.getStats().status, 'terrain-required');
  assert.equal(world.renderer.shown.length, 0);
  assert.equal(layerFeedState(world.layer.getStats()), 'terrain-required');
  await world.layer.disable();
  assert.equal(world.stacks.includes('photoreal'), false, 'radar no longer owns the stack');
});

test('share restore on photoreal does not steal the basemap', async () => {
  const world = createLayer({ stackId: 'photoreal' });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'share-restore' });
  assert.deepEqual(world.stacks, []);
  assert.equal(world.layer.getStats().status, 'terrain-required');
  await world.layer.disable();
  assert.deepEqual(world.stacks, []);
});

test('a later Bing choice drops radar map ownership so disable does not restore photoreal', async () => {
  const world = createLayer({ stackId: 'photoreal' });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, ['osm']);
  world.setStack('bing-aerial');
  world.host.emit('gev:map-stack-changed', { activeId: 'bing-aerial' });
  await world.layer.disable();
  assert.deepEqual(world.stacks, ['osm']);
});

test('playback of older advertised frames is history, not a stale feed fault', async () => {
  const world = createLayer({
    now: () => FRAMES[2].validTime + 25 * 60_000,
  });
  world.layer.init({});
  await world.layer.enable();
  assert.equal(world.layer.getStats().status, 'stale');
  world.layer.setParams({ playing: true });
  assert.equal(world.layer.getStats().status, 'history');
  assert.equal(layerFeedState(world.layer.getStats()), 'history');
  await world.layer.disable();
});

test('enable/disable/re-enable destroys imagery and can fetch again', async () => {
  const world = createLayer();
  world.layer.init({});
  await world.layer.enable();
  await world.layer.disable();
  await world.layer.enable();
  assert.equal(world.fetches.length, 2);
  assert.equal(world.renderer.shown.at(-1), '1788564600');
  await world.layer.destroy();
  assert.equal(world.host.listenerCount('gev:map-stack-changed'), 0);
});

test('empty catalog is unavailable; play walks advertised frames only', async () => {
  const empty = createLayer({
    fetchImpl: async () => jsonResponse(catalogPayload({ frames: [], catalogStatus: 'unavailable' })),
  });
  empty.layer.init({});
  await empty.layer.enable();
  assert.equal(empty.layer.getStats().status, 'unavailable');
  assert.equal(layerFeedState(empty.layer.getStats()), 'unavailable');

  const queued = [];
  const host = createHost();
  host.setTimeout = (fn) => { queued.push(fn); return queued.length; };
  host.clearTimeout = () => { queued.length = 0; };
  const world = createLayer({ host });
  world.layer.init({});
  await world.layer.enable();
  assert.equal(world.layer.setParams({ playing: true }), true);
  assert.equal(queued.length, 1);
  world.renderer.shown.length = 0;
  const painted = new Promise((resolve) => {
    const inner = world.renderer.showFrame.bind(world.renderer);
    world.renderer.showFrame = async (id) => {
      const result = await inner(id);
      resolve(id);
      return result;
    };
  });
  queued.shift()();
  assert.equal(await painted, '1788563400');
  world.layer.setParams({ followLatest: true });
  assert.equal(world.layer.getParams().playing, false);
  assert.equal(world.layer.getParams().followLatest, true);
});

test('row chips encode opacity and do not leak playback into getParams defaults', async () => {
  const world = createLayer();
  world.layer.init({});
  await world.layer.enable();
  const chips = world.layer.getRowControls().chips;
  assert.deepEqual(chips.map((chip) => chip.id), ['opacity-40', 'opacity-65', 'opacity-100', 'latest', 'play']);
  assert.equal(world.layer.setParams({ opacity: 40 }), true);
  assert.equal(world.layer.getParams().opacity, 40);
  assert.equal(world.layer.setParams({ opacity: 12 }), false);
});

test('manager can register and destroy the radar layer', async () => {
  const world = createLayer();
  const manager = new DataLayerManager({});
  manager.register(world.layer);
  await manager.setEnabled('weather-radar', true);
  assert.equal(manager.isEnabled('weather-radar'), true);
  await manager.destroyLayer('weather-radar');
  assert.equal(manager.layers.has('weather-radar'), false);
});

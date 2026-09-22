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
    isStackAvailable: overrides.isStackAvailable || (() => false),
    getSwitchGeneration: overrides.getSwitchGeneration || null,
    setMapStack: overrides.setMapStack || (async (id) => {
      stacks.push(id);
      stackId = id;
      return { ok: true, activeStack: id };
    }),
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

test('enable on photoreal prefers Bing Aerial when ion imagery is available', async () => {
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, ['bing-aerial']);
  assert.equal(world.getStack(), 'bing-aerial');
  assert.equal(world.layer.getParams().opacity, 40);
  assert.equal(world.renderer.shown.at(-1), '1788564600');
  await world.layer.disable();
  assert.deepEqual(world.stacks, ['bing-aerial', 'photoreal']);
});

test('a later Labels choice keeps the operator opacity and map', async () => {
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial' || id === 'bing-labels',
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  world.layer.setParams({ opacity: 100 });
  world.setStack('bing-labels');
  world.host.emit('gev:map-stack-changed', { activeId: 'bing-labels' });
  assert.equal(world.layer.getParams().opacity, 100);
  assert.equal(world.getStack(), 'bing-labels');
  await world.layer.disable();
  assert.equal(world.getStack(), 'bing-labels');
});

test('restored default opacity does not block the Bing preset', async () => {
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  world.layer.setParams({ opacity: 65 }, { origin: 'share-restore' });
  await world.layer.enable({}, { origin: 'user' });
  assert.equal(world.getStack(), 'bing-aerial');
  assert.equal(world.layer.getParams().opacity, 40);
});

test('enable while already on Bing Aerial uses the satellite opacity', async () => {
  const world = createLayer({
    stackId: 'bing-aerial',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, []);
  assert.equal(world.layer.getParams().opacity, 40);
});

test('turning radar off during an in-flight Aerial switch restores 3D', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
    setMapStack: async (id) => {
      world.stacks.push(id);
      await gate;
      world.setStack(id);
      return { ok: true, activeStack: id };
    },
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'share-restore' });
  const switching = world.layer.setParams({ showOnTerrain: true });
  const disabled = world.layer.disable();
  release();
  await switching;
  await disabled;
  assert.equal(world.getStack(), 'photoreal');
  await world.layer.enable({}, { origin: 'user' });
  await world.layer.disable();
  assert.equal(world.getStack(), 'photoreal');
});

test('enable on photoreal falls back to OSM without ion', async () => {
  const world = createLayer({ stackId: 'photoreal' });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, ['osm']);
  assert.equal(world.layer.getParams().opacity, 65);
});

test('3D hides radar until Show on Aerial', async () => {
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'share-restore' });
  assert.equal(world.layer.getStats().status, 'terrain-required');
  assert.match(world.layer.getStats().source, /3D HIDES RADAR/);
  const chip = world.layer.getRowControls().chips.find((item) => item.id === 'show-on-terrain');
  assert.equal(chip.label, 'AERIAL');
  assert.equal(world.layer.setParams(chip.params), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.getStack(), 'bing-aerial');
  assert.equal(world.layer.getParams().opacity, 40);
  assert.equal(world.layer.getStats().status, 'latest');
});

test('a restored 100 is not snapped to the Bing preset', async () => {
  const world = createLayer({
    stackId: 'osm',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  world.layer.setParams({ opacity: 100 }, { origin: 'local-restore' });
  await world.layer.enable({}, { origin: 'local-restore' });
  assert.equal(world.layer.getParams().opacity, 100);
  world.setStack('bing-aerial');
  world.host.emit('gev:map-stack-changed', { activeId: 'bing-aerial' });
  assert.equal(world.layer.getParams().opacity, 100);
});

test('a newer map choice during Aerial does not get stolen by OSM', async () => {
  let gen = 0;
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
    getSwitchGeneration: () => gen,
    setMapStack: async (id) => {
      const mine = ++gen;
      world.stacks.push(id);
      if (id === 'bing-aerial') {
        gen += 1;
        world.setStack('photoreal');
        return { ok: false, activeStack: 'photoreal', generation: mine };
      }
      world.setStack(id);
      return { ok: true, activeStack: id };
    },
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.equal(world.getStack(), 'photoreal');
  assert.equal(world.stacks.includes('osm'), false);
});

test('Bing imagery failure falls back to OSM instead of throwing', async () => {
  const world = createLayer({
    stackId: 'photoreal',
    isStackAvailable: (id) => id === 'bing-aerial',
    setMapStack: async (id) => {
      world.stacks.push(id);
      if (id === 'bing-aerial') return { ok: false, activeStack: 'photoreal' };
      world.setStack(id);
      return { ok: true, activeStack: id };
    },
  });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.equal(world.getStack(), 'osm');
  assert.equal(world.layer.getStats().status, 'latest');
});

test('a chosen 65 stays 65 on Bing after restore', async () => {
  const world = createLayer({
    stackId: 'bing-aerial',
    isStackAvailable: (id) => id === 'bing-aerial',
  });
  world.layer.init({});
  world.layer.setParams({ opacity: 65, opacityChosen: true }, { origin: 'share-restore' });
  await world.layer.enable({}, { origin: 'share-restore' });
  world.host.emit('gev:map-stack-changed', { activeId: 'bing-aerial' });
  assert.equal(world.layer.getParams().opacity, 65);
  assert.equal(world.layer.getParams().opacityChosen, true);
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
  assert.ok(world.fetches.length > 0, 'catalog still loads while suspended');
  const painted = new Promise((resolve) => {
    const inner = world.renderer.showFrame.bind(world.renderer);
    world.renderer.showFrame = async (id) => {
      const result = await inner(id);
      resolve(id);
      return result;
    };
  });
  world.setStack('osm');
  world.host.emit('gev:map-stack-changed', { activeId: 'osm' });
  assert.equal(await painted, '1788564600');
  await world.layer.disable();
  assert.deepEqual(world.stacks, []);
});

test('cockpit enable does not switch the basemap', async () => {
  const host = createHost();
  host.document.body.classList.contains = () => true;
  const world = createLayer({ stackId: 'photoreal', host });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, []);
  assert.equal(world.layer.getStats().status, 'cockpit-suspended');
  assert.ok(world.fetches.length > 0);
});

test('cockpit exit still switches photoreal after an explicit enable deferred in cockpit', async () => {
  const host = createHost();
  host.document.body.classList.contains = (name) => name === 'cockpit-mode';
  const world = createLayer({ stackId: 'photoreal', host });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, []);
  const painted = new Promise((resolve) => {
    const inner = world.renderer.showFrame.bind(world.renderer);
    world.renderer.showFrame = async (id) => {
      const result = await inner(id);
      resolve(id);
      return result;
    };
  });
  host.document.body.classList.contains = () => false;
  world.host.emit('gev:cockpit-mode-changed', { active: false });
  assert.equal(await painted, '1788564600');
  assert.deepEqual(world.stacks, ['osm']);
  assert.equal(world.getStack(), 'osm');
  assert.equal(world.layer.getStats().status, 'latest');
});

test('map choice while cockpit is on drops the deferred OSM switch', async () => {
  const host = createHost();
  host.document.body.classList.contains = (name) => name === 'cockpit-mode';
  const world = createLayer({ stackId: 'photoreal', host });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, []);
  world.host.emit('gev:map-stack-changed', { activeId: 'photoreal' });
  host.document.body.classList.contains = () => false;
  world.host.emit('gev:cockpit-mode-changed', { active: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.getStack(), 'photoreal');
  assert.deepEqual(world.stacks, []);
  assert.equal(world.layer.getStats().status, 'terrain-required');
});

test('cockpit exit does not steal a later photoreal choice', async () => {
  const world = createLayer({ stackId: 'photoreal' });
  world.layer.init({});
  await world.layer.enable({}, { origin: 'user' });
  assert.deepEqual(world.stacks, ['osm']);
  world.setStack('photoreal');
  world.host.emit('gev:map-stack-changed', { activeId: 'photoreal' });
  assert.equal(world.layer.getStats().status, 'terrain-required');
  world.host.document.body.classList.contains = (name) => name === 'cockpit-mode';
  world.host.emit('gev:cockpit-mode-changed', { active: true });
  assert.equal(world.layer.getStats().status, 'cockpit-suspended');
  world.host.document.body.classList.contains = () => false;
  world.host.emit('gev:cockpit-mode-changed', { active: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.getStack(), 'photoreal');
  assert.deepEqual(world.stacks, ['osm']);
  assert.equal(world.layer.getStats().status, 'terrain-required');
  assert.equal(world.renderer.shown.length, 0);
});

test('PLAY does not advance the timestamp when the next frame does not paint', async () => {
  const queued = [];
  const host = createHost();
  host.setTimeout = (fn) => { queued.push(fn); return queued.length; };
  host.clearTimeout = () => { queued.length = 0; };
  const world = createLayer({ host });
  const inner = world.renderer.showFrame.bind(world.renderer);
  world.renderer.showFrame = async (id) => {
    if (id === '1788563400') return false;
    return inner(id);
  };
  world.layer.init({});
  await world.layer.enable();
  assert.equal(world.layer.getStats().frameId, '1788564600');
  assert.equal(world.layer.setParams({ playing: true }), true);
  queued.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.layer.getStats().frameId, '1788564600');
  assert.equal(world.layer.getParams().followLatest, false);
});

test('disable then enable does not resume PLAY', async () => {
  const queued = [];
  const host = createHost();
  host.setTimeout = (fn) => { queued.push(fn); return queued.length; };
  host.clearTimeout = () => { queued.length = 0; };
  const world = createLayer({ host });
  world.layer.init({});
  await world.layer.enable();
  assert.equal(world.layer.setParams({ playing: true }), true);
  assert.equal(world.layer.getParams().playing, true);
  assert.equal(world.layer.getParams().followLatest, false);
  assert.equal(queued.length, 1);
  await world.layer.disable();
  assert.equal(world.layer.getParams().playing, false);
  assert.equal(world.layer.getParams().followLatest, true);
  queued.length = 0;
  await world.layer.enable();
  assert.equal(world.layer.getParams().playing, false);
  assert.equal(world.layer.getParams().followLatest, true);
  assert.equal(world.layer.getStats().status, 'latest');
  assert.equal(queued.length, 0);
  const chips = world.layer.getRowControls().chips;
  assert.equal(chips.find((chip) => chip.id === 'play').active, false);
  assert.equal(chips.find((chip) => chip.id === 'latest').active, true);
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

test('manager enable stays ON when the catalog is unavailable', async () => {
  const world = createLayer({
    fetchImpl: async () => jsonResponse(catalogPayload({ frames: [], catalogStatus: 'unavailable' })),
  });
  const manager = new DataLayerManager({});
  manager.register(world.layer);
  const changes = [];
  manager.subscribe((change) => changes.push(change.type));
  assert.equal(await manager.setEnabled('weather-radar', true, { origin: 'user' }), true);
  assert.equal(manager.isEnabled('weather-radar'), true);
  assert.equal(world.layer.getStats().status, 'unavailable');
  assert.equal(changes.includes('visibility-failed'), false);
  await world.layer.disable();
  assert.equal(world.layer.getStats().countLabel, '');
  await manager.destroyLayer('weather-radar');
});

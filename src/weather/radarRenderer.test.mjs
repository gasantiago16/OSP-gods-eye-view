import assert from 'node:assert/strict';
import test from 'node:test';

import { createRadarRenderer } from './radarRenderer.js';

function fakeCesiumViewer() {
  const added = [];
  const removed = [];
  return {
    viewer: {
      scene: { globe: { show: true } },
      imageryLayers: {
        add(layer) { added.push(layer); },
        remove(layer) { removed.push(layer); },
      },
    },
    added,
    removed,
    CesiumImpl: {
      UrlTemplateImageryProvider: class { constructor(options) { this.url = options.url; } },
      ImageryLayer: class { constructor(provider) { this.provider = provider; this.alpha = 1; } },
    },
  };
}

test('showFrame keeps a single Cesium layer and removes the previous one', async () => {
  const world = fakeCesiumViewer();
  const renderer = createRadarRenderer({
    CesiumImpl: world.CesiumImpl,
    requestRender: () => {},
  });
  renderer.attach(world.viewer);
  await renderer.showFrame('1');
  await renderer.showFrame('2');
  await renderer.showFrame('3');
  assert.equal(renderer.layerCount(), 1);
  assert.equal(world.added.length, 3);
  assert.equal(world.removed.length, 2);
  await renderer.showFrame('1');
  assert.equal(renderer.layerCount(), 1);
  renderer.clear();
  assert.equal(renderer.layerCount(), 0);
  assert.equal(world.added.length, world.removed.length);
});

test('showFrame holds the last-good layer until the next frame returns a tile', async () => {
  let resolveTile;
  const pending = new Promise((resolve) => { resolveTile = resolve; });
  const world = fakeCesiumViewer();
  world.CesiumImpl.UrlTemplateImageryProvider = class {
    constructor(options) {
      this.url = options.url;
      if (String(options.url).includes('/2/')) {
        this.requestImage = () => pending;
      }
    }
  };
  const renderer = createRadarRenderer({
    CesiumImpl: world.CesiumImpl,
    requestRender: () => {},
    swapWaitMs: 200,
  });
  renderer.attach(world.viewer);
  await renderer.showFrame('1');
  assert.equal(renderer.layerCount(), 1);
  const second = renderer.showFrame('2');
  await Promise.resolve();
  assert.equal(world.added.length, 2);
  assert.equal(world.removed.length, 0);
  assert.equal(world.added[1].alpha, 0);
  assert.equal(renderer.activeFrameId(), '1');
  world.added[1].provider.requestImage(0, 0, 0);
  resolveTile({ width: 256, height: 256 });
  assert.equal(await second, true);
  assert.equal(renderer.layerCount(), 1);
  assert.equal(renderer.activeFrameId(), '2');
  assert.equal(world.removed.length, 1);
  assert.equal(world.added[1].alpha, renderer.getOpacity());
});

test('showFrame keeps the last-good layer when the next frame never returns a tile', async () => {
  const world = fakeCesiumViewer();
  world.CesiumImpl.UrlTemplateImageryProvider = class {
    constructor(options) {
      this.url = options.url;
      if (String(options.url).includes('/2/')) {
        this.requestImage = () => new Promise(() => {});
      }
    }
  };
  const renderer = createRadarRenderer({
    CesiumImpl: world.CesiumImpl,
    requestRender: () => {},
    swapWaitMs: 20,
  });
  renderer.attach(world.viewer);
  await renderer.showFrame('1');
  assert.equal(await renderer.showFrame('2'), false);
  assert.equal(renderer.activeFrameId(), '1');
  assert.equal(renderer.layerCount(), 1);
  assert.equal(world.added.length, 2);
  assert.equal(world.removed.length, 1);
});

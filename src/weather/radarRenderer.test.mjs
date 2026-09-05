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

/**
 * Cesium imagery-layer owner for one radar product.
 * One radar frame is visible. The next frame loads at alpha 0 and replaces
 * the outgoing layer only after a tile succeeds, so PLAY cannot flash a
 * global "no rain" globe. Paused frames do not hold the render governor
 * continuous.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { MAX_RADAR_ZOOM, PUBLIC_TILE_TEMPLATE } from './timeline.js';

function globeShowsImagery(viewer) {
  return Boolean(viewer?.scene?.globe?.show);
}

function tileUrlForFrame(frameId) {
  return PUBLIC_TILE_TEMPLATE.replace('{frame}', String(frameId));
}

export const RADAR_FRAME_SWAP_WAIT_MS = 8_000;

function firstTileOrTimeout(provider, { timeoutMs, onAbort }) {
  if (typeof provider?.requestImage !== 'function') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    onAbort?.(() => {
      clearTimeout(timer);
      finish(false);
    });
    const original = provider.requestImage.bind(provider);
    provider.requestImage = function wrappedRequestImage(x, y, level, request) {
      const result = original(x, y, level, request);
      if (result && typeof result.then === 'function') {
        result.then((image) => {
          if (image) {
            clearTimeout(timer);
            finish(true);
          }
        }, () => {});
      }
      return result;
    };
  });
}

export function createRadarRenderer({
  CesiumImpl = Cesium,
  requestRender = governorRequestRender,
  swapWaitMs = RADAR_FRAME_SWAP_WAIT_MS,
} = {}) {
  let viewer = null;
  let opacity = 0.65;
  /** @type {Array<{ id: string, layer: object }>} */
  let layers = [];
  let swapEpoch = 0;
  let pendingAbort = null;

  function currentId() {
    return layers[layers.length - 1]?.id || null;
  }

  function removeLayer(entry, destroy = true) {
    if (!entry || !viewer) return;
    try {
      viewer.imageryLayers.remove(entry.layer, destroy);
    } catch {
      // Layer may already have been removed by a map-stack swap.
    }
  }

  return {
    attach(nextViewer) {
      viewer = nextViewer || null;
    },

    setOpacity(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return opacity;
      opacity = Math.max(0, Math.min(1, numeric));
      for (const entry of layers) {
        if (entry.layer) entry.layer.alpha = opacity;
      }
      requestRender('weather-radar-opacity');
      return opacity;
    },

    getOpacity() {
      return opacity;
    },

    activeFrameId() {
      return currentId();
    },

    layerCount() {
      return layers.length;
    },

    async showFrame(frameId) {
      const id = String(frameId || '');
      if (!viewer || !id) return false;
      if (!globeShowsImagery(viewer)) {
        this.clear();
        return false;
      }
      if (currentId() === id && layers.length === 1) return true;

      pendingAbort?.();
      pendingAbort = null;
      const epoch = ++swapEpoch;
      const provider = new CesiumImpl.UrlTemplateImageryProvider({
        url: tileUrlForFrame(id),
        maximumLevel: MAX_RADAR_ZOOM,
        tileWidth: 256,
        tileHeight: 256,
        hasAlphaChannel: true,
        enablePickFeatures: false,
      });
      const hadPrevious = layers.length > 0;
      let myAbort = null;
      const usablePromise = firstTileOrTimeout(provider, {
        timeoutMs: swapWaitMs,
        onAbort: (fn) => {
          myAbort = fn;
          pendingAbort = fn;
        },
      });
      const layer = new CesiumImpl.ImageryLayer(provider);
      layer.alpha = 0;
      viewer.imageryLayers.add(layer);
      const incoming = { id, layer };
      const usable = await usablePromise;
      if (pendingAbort === myAbort) pendingAbort = null;
      if (epoch !== swapEpoch) {
        removeLayer(incoming, true);
        return false;
      }
      if (!usable && hadPrevious) {
        removeLayer(incoming, true);
        requestRender('weather-radar-frame');
        return false;
      }
      layer.alpha = opacity;
      for (const entry of layers) removeLayer(entry, true);
      layers = [incoming];
      requestRender('weather-radar-frame');
      return true;
    },

    clear() {
      pendingAbort?.();
      pendingAbort = null;
      swapEpoch += 1;
      for (const entry of layers) removeLayer(entry, true);
      layers = [];
      requestRender('weather-radar-clear');
    },

    destroy() {
      this.clear();
      viewer = null;
    },
  };
}

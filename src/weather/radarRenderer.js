/**
 * Cesium imagery-layer owner for one radar product.
 * At most two layers exist during a frame swap. Paused frames do not hold
 * the render governor continuous.
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

export function createRadarRenderer({
  CesiumImpl = Cesium,
  requestRender = governorRequestRender,
} = {}) {
  let viewer = null;
  let opacity = 0.65;
  /** @type {Array<{ id: string, layer: object }>} */
  let layers = [];
  let swapEpoch = 0;

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

      const epoch = ++swapEpoch;
      const provider = new CesiumImpl.UrlTemplateImageryProvider({
        url: tileUrlForFrame(id),
        maximumLevel: MAX_RADAR_ZOOM,
        tileWidth: 256,
        tileHeight: 256,
        hasAlphaChannel: true,
        enablePickFeatures: false,
      });
      const layer = new CesiumImpl.ImageryLayer(provider);
      layer.alpha = opacity;
      viewer.imageryLayers.add(layer);
      const incoming = { id, layer };
      const next = [...layers.filter((entry) => entry.id !== id), incoming];
      const kept = next.slice(-2);
      for (const entry of layers) {
        if (!kept.includes(entry)) removeLayer(entry, true);
      }
      layers = kept;
      if (epoch !== swapEpoch) return false;
      requestRender('weather-radar-frame');
      return true;
    },

    clear() {
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

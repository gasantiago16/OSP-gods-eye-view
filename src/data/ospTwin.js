/**
 * Boca→Maui OSP twin. A recorded run_ptp polyline, not a Launch Library replay.
 * Label is OSP ECI TRUTH. Weather must not rewrite these samples.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { PAD_VIEWS } from './padViews.js';

export const OSP_TWIN_LAYER_ID = 'osp-twin';
export const OSP_TWIN_URL = '/osp/boca-maui.json';
export const OSP_TWIN_LABEL = 'OSP ECI TRUTH';

export function validateTwin(doc) {
  if (!doc || doc.schema !== 'osp-twin-lla-v1') return 'bad schema';
  if (doc.label !== OSP_TWIN_LABEL) return 'missing OSP ECI TRUTH label';
  if (!Array.isArray(doc.samples) || doc.samples.length < 2) return 'need samples';
  for (const sample of doc.samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lon) || !Number.isFinite(sample.alt_m)) {
      return 'sample missing lat/lon/alt';
    }
  }
  return null;
}

export function positionsFromTwin(CesiumImpl, samples) {
  const flat = [];
  for (const sample of samples) {
    flat.push(sample.lon, sample.lat, sample.alt_m);
  }
  return CesiumImpl.Cartesian3.fromDegreesArrayHeights(flat);
}

export function createOspTwinLayer({
  url = OSP_TWIN_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  CesiumImpl = Cesium,
  requestRender = governorRequestRender,
} = {}) {
  let viewer = null;
  let enabled = false;
  let entities = [];
  let twin = null;
  let lastError = null;

  function clearEntities() {
    if (!viewer) {
      entities = [];
      return;
    }
    for (const entity of entities) {
      viewer.entities.remove(entity);
    }
    entities = [];
  }

  function paint() {
    clearEntities();
    if (!viewer || !twin) return false;
    const positions = positionsFromTwin(CesiumImpl, twin.samples);
    const end = twin.samples[twin.samples.length - 1];
    const line = viewer.entities.add({
      id: 'osp-twin-boca-maui',
      name: OSP_TWIN_LABEL,
      polyline: {
        positions,
        width: 3,
        arcType: CesiumImpl.ArcType.NONE,
        material: CesiumImpl.Color.fromCssColorString('#ffb000'),
        clampToGround: false,
      },
    });
    const marker = viewer.entities.add({
      id: 'osp-twin-boca-maui-catch',
      name: OSP_TWIN_LABEL,
      position: CesiumImpl.Cartesian3.fromDegrees(end.lon, end.lat, end.alt_m),
      point: {
        pixelSize: 10,
        color: CesiumImpl.Color.fromCssColorString('#ffb000'),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: twin.catch ? 'OSP ECI TRUTH · CATCH' : 'OSP ECI TRUTH',
        font: '12px sans-serif',
        fillColor: CesiumImpl.Color.fromCssColorString('#ffb000'),
        outlineColor: CesiumImpl.Color.BLACK,
        outlineWidth: 2,
        style: CesiumImpl.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new CesiumImpl.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entities = [line, marker];
    requestRender('osp-twin-paint');
    return true;
  }

  const layer = {
    id: OSP_TWIN_LAYER_ID,
    name: 'OSP Twin',
    icon: '↗',
    group: 'space',

    init(nextViewer) {
      viewer = nextViewer;
    },

    async enable() {
      enabled = true;
      lastError = null;
      if (!twin) {
        const response = await fetchImpl(url);
        if (!response.ok) {
          lastError = `Twin HTTP ${response.status}`;
          return false;
        }
        const doc = await response.json();
        const problem = validateTwin(doc);
        if (problem) {
          lastError = problem;
          return false;
        }
        twin = doc;
      }
      if (!enabled) return false;
      paint();
      return true;
    },

    async disable() {
      enabled = false;
      clearEntities();
      requestRender('osp-twin-clear');
      return true;
    },

    async update() {
      return true;
    },

    flyToPad(padId) {
      const pad = PAD_VIEWS[padId];
      if (!viewer || !pad) return false;
      if (viewer?.scene?.canvas?.ownerDocument?.body?.classList?.contains('cockpit-mode')) {
        return false;
      }
      const camera = viewer.camera;
      if (!camera?.flyTo) return false;
      camera.flyTo({
        destination: CesiumImpl.Cartesian3.fromDegrees(pad.lon, pad.lat, pad.alt),
        orientation: {
          heading: CesiumImpl.Math.toRadians(pad.heading),
          pitch: CesiumImpl.Math.toRadians(pad.pitch),
          roll: 0,
        },
        duration: 1.6,
      });
      requestRender('osp-twin-pad');
      return true;
    },

    flyTo() {
      if (!viewer || entities.length === 0) return false;
      const sphere = CesiumImpl.BoundingSphere.fromPoints(
        entities[0].polyline.positions.getValue
          ? entities[0].polyline.positions.getValue()
          : entities[0].polyline.positions,
      );
      viewer.camera.flyToBoundingSphere(sphere, { duration: 1.4 });
      return true;
    },

    getRowControls() {
      return {
        chips: [
          ...Object.values(PAD_VIEWS).map((pad) => ({
            id: `pad-${pad.id}`,
            label: pad.label,
            active: false,
            disabled: !enabled,
            title: `${pad.name}. Share link #pad=${pad.id}`,
            params: { pad: pad.id },
          })),
          {
            id: 'fly',
            label: 'FLY',
            active: false,
            disabled: !enabled || !twin,
            title: 'Frame the Boca to Maui OSP twin',
            params: { fly: true },
          },
        ],
        legend: [{
          label: OSP_TWIN_LABEL,
          color: '#ffb000',
          blurb: twin?.source || 'Simulated run_ptp. Not a flown vehicle.',
        }],
      };
    },

    setParams(next = {}) {
      if (next.pad) layer.flyToPad(next.pad);
      if (next.fly) layer.flyTo();
      return true;
    },

    getParams() {
      return {};
    },

    getStats() {
      const missKm = twin && Number.isFinite(twin.miss_m) ? (twin.miss_m / 1000).toFixed(1) : null;
      const outcome = !twin ? '' : (twin.catch ? `CATCH · miss ${missKm} km` : 'NO CATCH');
      return {
        count: twin?.samples?.length || 0,
        countLabel: twin ? `${twin.originId} → ${twin.targetId}` : '',
        loading: false,
        status: lastError ? 'unavailable' : (enabled ? 'nominal' : 'off'),
        source: twin ? `${OSP_TWIN_LABEL} · ${outcome}` : OSP_TWIN_LABEL,
        coverage: twin?.source || '',
        error: lastError,
        attribution: 'Simulated OSP run_ptp. Not Launch Library. Not a flown Starship.',
        frameId: twin?.missionId || null,
      };
    },

    async destroy() {
      await layer.disable();
      viewer = null;
      twin = null;
    },
  };

  return layer;
}

export default createOspTwinLayer;

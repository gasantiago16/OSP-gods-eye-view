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

const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

/** ECEF meters from sample LLA. Not ECI — the pack has no absolute epoch. */
export function llaToEcef(latDeg, lonDeg, altM) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + altM) * cosLat * Math.cos(lon),
    y: (n + altM) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altM) * sinLat,
  };
}

export function honestyLines(twin, sample) {
  const ecef = llaToEcef(sample.lat, sample.lon, sample.alt_m);
  const miss = Number.isFinite(twin.miss_m) ? `${Math.round(twin.miss_m)} m` : 'n/a';
  return [
    OSP_TWIN_LABEL,
    `pack ${twin.missionId || 'unknown'} / ${twin.vehicleId || 'unknown'}`,
    twin.catch ? `CATCH miss ${miss}` : `NO CATCH miss ${miss}`,
    `LLA ${sample.lat.toFixed(5)} ${sample.lon.toFixed(5)} ${Math.round(sample.alt_m)} m`,
    `ECEF ${Math.round(ecef.x)} ${Math.round(ecef.y)} ${Math.round(ecef.z)} m`,
    'ECI not in pack (no absolute epoch)',
    'Not a flown vehicle. Not Launch Library.',
  ];
}

function honestyLegend(twin, selected) {
  if (!selected || !twin?.samples?.length) {
    return [{
      label: 'Select the amber line',
      color: '#ffb000',
      blurb: 'Pack, miss, LLA, and ECEF appear when the twin is selected. ECI is not in this pack.',
    }];
  }
  const sample = twin.samples[twin.samples.length - 1];
  return honestyLines(twin, sample).map((label) => ({
    label,
    color: '#ffb000',
  }));
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
  let selected = false;
  let rowListener = null;
  let removeSelection = null;

  function notifyRow() {
    if (typeof rowListener === 'function') rowListener();
  }

  function syncSelection() {
    const current = viewer?.selectedEntity;
    const nowSelected = entities.some((entity) => entity === current);
    if (nowSelected === selected) return;
    selected = nowSelected;
    notifyRow();
  }

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
    const honesty = honestyLines(twin, end).join('\n');
    const line = viewer.entities.add({
      id: 'osp-twin-boca-maui',
      name: OSP_TWIN_LABEL,
      description: honesty,
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
      description: honesty,
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
      if (removeSelection) removeSelection();
      removeSelection = null;
      const changed = viewer?.selectedEntityChanged;
      if (changed?.addEventListener) {
        removeSelection = changed.addEventListener(syncSelection);
      }
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
      selected = false;
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
        legend: honestyLegend(twin, selected),
      };
    },

    setRowControlsListener(listener) {
      rowListener = listener;
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
      if (removeSelection) removeSelection();
      removeSelection = null;
      await layer.disable();
      viewer = null;
      twin = null;
    },
  };

  return layer;
}

export default createOspTwinLayer;

/**
 * Live RainViewer composite radar layer.
 *
 * Cesium imagery is invisible on Google Photoreal 3D (`globe.show === false`).
 * Enabling this layer on photoreal switches to Bing Aerial when that stack is
 * available, otherwise OSM, then restores the previous stack on disable only
 * if this layer still owns the switch.
 */

import { createRadarRenderer } from '../weather/radarRenderer.js';
import {
  formatFrameAge,
  formatValidTimeZ,
  frameAgeMs,
  isFrameStale,
  nextPlaybackIndex,
  pickLatestFrame,
  RADAR_CATALOG_POLL_MS,
  RADAR_DEFAULT_OPACITY,
  RADAR_OPACITY_PRESETS,
  RADAR_PLAYBACK_MS,
} from '../weather/timeline.js';
import { governorRequestRender } from '../renderGovernor.js';

export const WEATHER_RADAR_LAYER_ID = 'weather-radar';
export const WEATHER_RADAR_OPACITY_PRESETS = RADAR_OPACITY_PRESETS;
export const WEATHER_RADAR_DEFAULT_OPACITY = RADAR_DEFAULT_OPACITY;

const CATALOG_URL = '/api/weather-radar/catalog';

function clampOpacityPercent(value) {
  const numeric = Number(value);
  if (WEATHER_RADAR_OPACITY_PRESETS.includes(numeric)) return numeric;
  return null;
}

function stackAllowsRadar(stackId) {
  return Boolean(stackId) && stackId !== 'photoreal';
}

function isExplicitRadarIntent(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

function readCockpitActive(host) {
  const doc = host?.document;
  return Boolean(doc?.body?.classList?.contains('cockpit-mode'));
}

function readHidden(host) {
  return Boolean(host?.document?.hidden);
}

export function createWeatherRadarLayer({
  renderer = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  getActiveStackId = () => null,
  setMapStack = null,
  isStackAvailable = () => false,
  onStackOpacity = null,
  now = () => Date.now(),
  host = globalThis,
  requestRender = governorRequestRender,
  playbackMs = RADAR_PLAYBACK_MS,
} = {}) {
  const radar = renderer || createRadarRenderer({ requestRender });
  let viewer = null;
  let enabled = false;
  let loading = false;
  let opacityPercent = WEATHER_RADAR_DEFAULT_OPACITY;
  let playing = false;
  let followLatest = true;
  let frames = [];
  let currentId = null;
  let catalogStatus = 'idle';
  let lastError = null;
  let lastUpdate = null;
  let retrievedAt = null;
  let attribution = 'RainViewer';
  let coverageNote = 'No color does not mean no rain. Coverage is not global. Max zoom 7.';
  let cockpitActive = false;
  let ownsMapSwitch = false;
  let stackBeforeRadar = null;
  let ownedTarget = null;
  let opacityTouched = false;
  let radarSwitchPending = false;
  let switchInflight = null;
  let switchEpoch = 0;
  let deferredTerrainSwitch = false;
  let catalogInflight = null;
  let playbackTimer = null;
  let rowControlsListener = null;
  let listenersBound = false;
  let fetchEpoch = 0;

  const timers = {
    setTimeout: (...args) => host.setTimeout?.(...args) ?? globalThis.setTimeout(...args),
    clearTimeout: (id) => (host.clearTimeout || globalThis.clearTimeout)(id),
  };

  function notifyRow() {
    try { rowControlsListener?.(); } catch { /* panel refresh is best effort */ }
  }

  function stopPlayback() {
    if (playbackTimer != null) {
      timers.clearTimeout(playbackTimer);
      playbackTimer = null;
    }
  }

  function resetPlaybackMode() {
    stopPlayback();
    playing = false;
    followLatest = true;
  }

  function presentationStatus() {
    if (!enabled) return 'off';
    if (cockpitActive) return 'cockpit-suspended';
    if (!stackAllowsRadar(getActiveStackId())) return 'terrain-required';
    if (loading && frames.length === 0) return 'loading';
    if (catalogStatus === 'unavailable' && frames.length === 0) return 'unavailable';
    const current = frames.find((frame) => frame.id === currentId) || pickLatestFrame(frames);
    if (!current) return loading ? 'loading' : 'unavailable';
    if (playing || !followLatest) return 'history';
    const latest = pickLatestFrame(frames);
    if (isFrameStale(latest, now())) return 'stale';
    return 'latest';
  }

  function canPaint() {
    return enabled && !cockpitActive && stackAllowsRadar(getActiveStackId()) && !readHidden(host);
  }

  async function paintCurrent() {
    if (!canPaint() || !currentId) {
      radar.clear();
      return false;
    }
    radar.setOpacity(opacityPercent / 100);
    return radar.showFrame(currentId);
  }

  function suspendImagery() {
    stopPlayback();
    radar.clear();
    requestRender('weather-radar-suspend');
  }

  async function resumePaint() {
    if (!enabled || !canPaint()) return false;
    if (frames.length === 0) await refreshCatalog();
    if (!enabled || !canPaint()) return false;
    const painted = currentId ? await paintCurrent() : false;
    if (playing) schedulePlayback();
    notifyRow();
    return painted;
  }

  function schedulePlayback() {
    stopPlayback();
    if (!playing || !canPaint() || frames.length === 0) return;
    playbackTimer = timers.setTimeout(() => {
      playbackTimer = null;
      const next = nextPlaybackIndex(frames, currentId);
      if (next < 0) return;
      const nextId = frames[next].id;
      void (async () => {
        radar.setOpacity(opacityPercent / 100);
        const painted = await radar.showFrame(nextId);
        if (painted && enabled) {
          followLatest = false;
          currentId = nextId;
        }
        if (playing && enabled) schedulePlayback();
        notifyRow();
      })();
    }, playbackMs);
  }

  function preferredTerrainStack() {
    if (typeof isStackAvailable === 'function' && isStackAvailable('bing-aerial')) {
      return 'bing-aerial';
    }
    return 'osm';
  }

  function stackDefaultOpacity(stackId) {
    if (stackId === 'bing-aerial' || stackId === 'bing-labels') return 40;
    return 65;
  }

  function applyStackOpacity(stackId) {
    const next = stackDefaultOpacity(stackId);
    if (next === opacityPercent) return;
    opacityPercent = next;
    radar.setOpacity(next / 100);
    if (typeof onStackOpacity === 'function') onStackOpacity(next);
  }

  async function ensureTerrainGlobe(origin) {
    const active = getActiveStackId();
    if (stackAllowsRadar(active)) return true;
    if (!isExplicitRadarIntent(origin) || typeof setMapStack !== 'function') return false;
    const target = preferredTerrainStack();
    const before = active;
    const epoch = ++switchEpoch;
    const work = (async () => {
      stackBeforeRadar = before;
      ownedTarget = target;
      radarSwitchPending = true;
      try {
        await setMapStack(target);
      } finally {
        radarSwitchPending = false;
      }
      if (epoch !== switchEpoch) return false;
      if (!enabled) {
        ownsMapSwitch = false;
        ownedTarget = null;
        if (getActiveStackId() === target && before && before !== target && typeof setMapStack === 'function') {
          radarSwitchPending = true;
          try { await setMapStack(before); } finally { radarSwitchPending = false; }
        }
        stackBeforeRadar = null;
        return false;
      }
      const landed = getActiveStackId() === target;
      ownsMapSwitch = landed;
      if (!landed) {
        ownedTarget = null;
        stackBeforeRadar = null;
      } else if (!opacityTouched) {
        applyStackOpacity(target);
      }
      return stackAllowsRadar(getActiveStackId());
    })();
    switchInflight = work;
    try {
      return await work;
    } finally {
      if (switchInflight === work) switchInflight = null;
    }
  }

  async function restoreOwnedStack() {
    if (!ownsMapSwitch) return;
    const restoreTo = stackBeforeRadar;
    const target = ownedTarget;
    const stillOnOwned = getActiveStackId() === target;
    ownsMapSwitch = false;
    stackBeforeRadar = null;
    ownedTarget = null;
    if (!stillOnOwned || !restoreTo || restoreTo === target) return;
    if (typeof setMapStack === 'function') {
      radarSwitchPending = true;
      try { await setMapStack(restoreTo); } finally { radarSwitchPending = false; }
    }
  }

  async function refreshCatalog() {
    if (readHidden(host)) return false;
    if (catalogInflight) return catalogInflight;
    const epoch = ++fetchEpoch;
    loading = true;
    lastError = null;
    const work = (async () => {
      try {
        const response = await fetchImpl(CATALOG_URL);
        if (epoch !== fetchEpoch) return false;
        if (!response.ok) {
          lastError = `Radar catalog HTTP ${response.status}`;
          catalogStatus = frames.length ? 'stale' : 'unavailable';
          return false;
        }
        const json = await response.json();
        if (epoch !== fetchEpoch) return false;
        const nextFrames = Array.isArray(json?.frames)
          ? json.frames
            .filter((frame) => frame && frame.id && Number.isFinite(frame.validTime))
            .map((frame) => ({ id: String(frame.id), validTime: Number(frame.validTime) }))
            .sort((a, b) => a.validTime - b.validTime)
          : [];
        frames = nextFrames;
        catalogStatus = json?.catalogStatus === 'stale'
          ? 'stale'
          : (nextFrames.length ? 'ready' : 'unavailable');
        attribution = json?.attribution || 'RainViewer';
        if (typeof json?.coverageNote === 'string' && json.coverageNote.trim()) {
          coverageNote = json.coverageNote.trim();
        }
        retrievedAt = json?.retrievedAt || new Date(now()).toISOString();
        lastUpdate = now();
        const latest = pickLatestFrame(frames);
        if (!latest) {
          currentId = null;
          return false;
        }
        if (followLatest || !frames.some((frame) => frame.id === currentId)) {
          currentId = latest.id;
        }
        return true;
      } catch (error) {
        if (epoch !== fetchEpoch) return false;
        lastError = error?.message || 'Radar catalog error';
        catalogStatus = frames.length ? 'stale' : 'unavailable';
        return false;
      } finally {
        if (epoch === fetchEpoch) loading = false;
        if (catalogInflight === work) catalogInflight = null;
      }
    })();
    catalogInflight = work;
    return work;
  }

  function onMapStackChanged(event) {
    if (!enabled) return;
    const activeId = event?.detail?.activeId || getActiveStackId();
    if (!radarSwitchPending) {
      ownsMapSwitch = false;
      deferredTerrainSwitch = false;
    }
    if (radarSwitchPending) return;
    if (!stackAllowsRadar(activeId)) {
      suspendImagery();
      notifyRow();
      return;
    }
    if (!opacityTouched) applyStackOpacity(activeId);
    void resumePaint();
  }

  function onCockpitMode(event) {
    cockpitActive = event?.detail?.active === true || readCockpitActive(host);
    if (!enabled) return;
    if (cockpitActive) {
      suspendImagery();
      notifyRow();
      return;
    }
    void (async () => {
      if (deferredTerrainSwitch) {
        deferredTerrainSwitch = false;
        await ensureTerrainGlobe('user');
      }
      await resumePaint();
    })();
  }

  function onVisibility() {
    if (!enabled) return;
    if (readHidden(host)) {
      stopPlayback();
      return;
    }
    void refreshCatalog().then((ok) => {
      if (ok) return paintCurrent();
      return false;
    }).then(() => {
      if (playing) schedulePlayback();
      notifyRow();
    });
  }

  function bindListeners() {
    if (listenersBound || !host?.addEventListener) return;
    host.addEventListener('gev:map-stack-changed', onMapStackChanged);
    host.addEventListener('gev:cockpit-mode-changed', onCockpitMode);
    host.document?.addEventListener?.('visibilitychange', onVisibility);
    listenersBound = true;
  }

  function unbindListeners() {
    if (!listenersBound || !host?.removeEventListener) return;
    host.removeEventListener('gev:map-stack-changed', onMapStackChanged);
    host.removeEventListener('gev:cockpit-mode-changed', onCockpitMode);
    host.document?.removeEventListener?.('visibilitychange', onVisibility);
    listenersBound = false;
  }

  const layer = {
    id: WEATHER_RADAR_LAYER_ID,
    name: 'Weather Radar',
    icon: '☔',
    source: 'RainViewer',
    updateInterval: RADAR_CATALOG_POLL_MS,

    init(nextViewer) {
      viewer = nextViewer;
      radar.attach(viewer);
      radar.setOpacity(opacityPercent / 100);
      enabled = false;
      resetPlaybackMode();
      deferredTerrainSwitch = false;
      frames = [];
      currentId = null;
      catalogStatus = 'idle';
      lastError = null;
      lastUpdate = null;
      cockpitActive = readCockpitActive(host);
    },

    async enable(_viewer, { origin = 'programmatic' } = {}) {
      enabled = true;
      cockpitActive = readCockpitActive(host);
      bindListeners();
      if (cockpitActive) {
        if (isExplicitRadarIntent(origin) && !stackAllowsRadar(getActiveStackId())) {
          deferredTerrainSwitch = true;
        }
        suspendImagery();
        await refreshCatalog();
        notifyRow();
        return true;
      }
      const terrainOk = await ensureTerrainGlobe(origin);
      if (terrainOk && !opacityTouched && isExplicitRadarIntent(origin)) {
        applyStackOpacity(getActiveStackId());
      }
      if (!enabled) return false;
      const ok = await refreshCatalog();
      if (!enabled) return false;
      if (!terrainOk) {
        suspendImagery();
        notifyRow();
        return true;
      }
      if (ok) await paintCurrent();
      if (playing) schedulePlayback();
      notifyRow();
      requestRender('weather-radar-enable');
      return true;
    },

    async disable() {
      enabled = false;
      deferredTerrainSwitch = false;
      fetchEpoch += 1;
      catalogInflight = null;
      loading = false;
      frames = [];
      currentId = null;
      catalogStatus = 'idle';
      lastError = null;
      lastUpdate = null;
      retrievedAt = null;
      resetPlaybackMode();
      radar.clear();
      unbindListeners();
      if (switchInflight) await switchInflight;
      await restoreOwnedStack();
      notifyRow();
      requestRender('weather-radar-disable');
      return true;
    },

    async update() {
      if (!enabled || readHidden(host) || cockpitActive) return true;
      if (!stackAllowsRadar(getActiveStackId())) return true;
      const ok = await refreshCatalog();
      if (ok && canPaint()) await paintCurrent();
      notifyRow();
      return true;
    },

    async destroy() {
      await layer.disable();
      radar.destroy();
      viewer = null;
      frames = [];
      currentId = null;
      rowControlsListener = null;
    },

    setParams(next = {}, context = {}) {
      let changed = false;
      const origin = context?.origin || 'user';
      const explicitOpacity = origin === 'user' || origin === 'voice' || origin === 'tool';
      if (Object.hasOwn(next, 'showOnTerrain') && next.showOnTerrain) {
        void ensureTerrainGlobe('user').then(() => {
          if (enabled && canPaint()) return paintCurrent();
          return false;
        }).then(() => notifyRow());
        return true;
      }
      if (Object.hasOwn(next, 'opacity')) {
        const opacity = clampOpacityPercent(next.opacity);
        if (opacity == null) return false;
        if (explicitOpacity || next.opacityChosen === true) {
          opacityTouched = true;
        }
        if (opacity !== opacityPercent) {
          opacityPercent = opacity;
          radar.setOpacity(opacityPercent / 100);
          changed = true;
        }
      }
      if (Object.hasOwn(next, 'playing')) {
        const want = Boolean(next.playing);
        if (want !== playing) {
          playing = want;
          if (playing) followLatest = false;
          changed = true;
        }
      }
      if (Object.hasOwn(next, 'followLatest') && next.followLatest) {
        followLatest = true;
        playing = false;
        const latest = pickLatestFrame(frames);
        if (latest) currentId = latest.id;
        changed = true;
      }
      if (!changed) return true;
      if (enabled && canPaint()) {
        void paintCurrent();
        if (playing) schedulePlayback();
        else stopPlayback();
      } else {
        stopPlayback();
      }
      notifyRow();
      return true;
    },

    getParams() {
      return {
        opacity: opacityPercent,
        opacityChosen: opacityTouched,
        playing,
        followLatest,
      };
    },

    getRowControls() {
      const status = presentationStatus();
      const disabled = !enabled || status === 'unavailable' || status === 'terrain-required'
        || status === 'cockpit-suspended';
      const chips = [];
      if (status === 'terrain-required') {
        const aerial = typeof isStackAvailable === 'function' && isStackAvailable('bing-aerial');
        chips.push({
          id: 'show-on-terrain',
          label: aerial ? 'AERIAL' : 'OSM',
          active: false,
          disabled: !enabled,
          title: aerial
            ? 'Google 3D hides radar. Show it on Bing Aerial.'
            : 'Google 3D hides radar. Show it on OSM.',
          params: { showOnTerrain: true },
        });
      }
      chips.push(...WEATHER_RADAR_OPACITY_PRESETS.map((value) => ({
        id: `opacity-${value}`,
        label: `${value}`,
        active: opacityPercent === value,
        disabled,
        title: `Radar opacity ${value}%`,
        params: { opacity: value },
      })));
      chips.push({
        id: 'latest',
        label: 'LATEST',
        active: followLatest && !playing,
        disabled: disabled || frames.length === 0,
        title: 'Jump to the newest advertised radar frame',
        params: { followLatest: true },
      });
      chips.push({
        id: 'play',
        label: playing ? 'PAUSE' : 'PLAY',
        active: playing,
        disabled: disabled || frames.length < 2,
        title: playing ? 'Pause radar playback' : 'Play advertised past frames',
        params: { playing: !playing },
      });
      return {
        chips,
        legend: [
          {
            label: 'LIGHT',
            color: '#3aa0ff',
            blurb: 'RainViewer Universal Blue. Transparent tiles are not clear skies.',
          },
          {
            label: 'HEAVY',
            color: '#6b2cff',
            blurb: coverageNote,
          },
        ],
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const status = presentationStatus();
      const current = frames.find((frame) => frame.id === currentId) || pickLatestFrame(frames);
      const ageMs = frameAgeMs(current, now());
      const validZ = current ? formatValidTimeZ(current.validTime) : '';
      let source = 'RAINVIEWER';
      if (status === 'terrain-required') source = '3D HIDES RADAR';
      else if (status === 'latest') source = 'RAINVIEWER · LIVE';
      else if (status === 'history') source = 'RAINVIEWER · PLAYBACK';
      else if (status === 'stale') source = 'RAINVIEWER · STALE';
      if (validZ) source = `${source} · ${validZ}`;
      return {
        count: frames.length,
        countLabel: status === 'off' ? '' : formatFrameAge(ageMs),
        lastUpdate,
        loading,
        stale: status === 'stale',
        status,
        source,
        coverage: coverageNote,
        error: status === 'unavailable'
          ? (lastError || 'Radar catalog unavailable')
          : null,
        attribution,
        retrievedAt,
        frameId: currentId,
      };
    },
  };

  return layer;
}

export default createWeatherRadarLayer;

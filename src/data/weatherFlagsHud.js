/**
 * GEV HUD for World Track Stage A weather flags.
 * Display + human ack only. RainViewer stays the picture. Not ATC.
 */

export const WEATHER_FLAGS_POLL_MS = 30_000;
export const WEATHER_SAMPLE_URL = '/api/osp-world/weather';
export const WEATHER_FLAGS_URL = '/api/osp-world/weather/flags';

export function cameraLla(viewer) {
  const cartesian = viewer?.camera?.positionWC;
  if (!cartesian || !globalThis.Cesium) return null;
  const carto = globalThis.Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: globalThis.Cesium.Math.toDegrees(carto.latitude),
    lon: globalThis.Cesium.Math.toDegrees(carto.longitude),
  };
}

export function formatFlagsView({ weather = {}, flags = {} } = {}) {
  const point = (weather.points && weather.points[0]) || {};
  const pending = (flags.flags || flags.new || []).filter((flag) => flag.ack === 'pending');
  return {
    catalogStatus: weather.catalogStatus || flags.catalogStatus || 'unavailable',
    dbz: point.dbz,
    coverage: point.coverage || 'unknown',
    validTime: weather.validTime || flags.validTime || null,
    stale: Boolean(weather.stale),
    pending,
    disclaimer: flags.disclaimer || 'Decision support. Not ATC. Human ack.',
  };
}

export function statusLine(view) {
  const dbz = view.dbz == null ? 'NO ECHO' : `${Number(view.dbz).toFixed(0)} dBZ`;
  const cover = String(view.coverage || 'unknown').toUpperCase();
  const status = String(view.catalogStatus || 'unavailable').toUpperCase();
  return `MRMS ${status}  ·  ${dbz}  ·  ${cover}`;
}

export function createWeatherFlagsHud({
  viewer = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  pollMs = WEATHER_FLAGS_POLL_MS,
  getLla = null,
  host = globalThis,
} = {}) {
  let root = null;
  let timer = null;
  let lastView = formatFlagsView();

  function lla() {
    if (typeof getLla === 'function') return getLla();
    return cameraLla(viewer);
  }

  async function poll() {
    const pos = lla();
    const where = pos
      ? `lat=${encodeURIComponent(pos.lat)}&lon=${encodeURIComponent(pos.lon)}`
      : '';
    const sampleQuery = where ? `?${where}` : '';
    const flagsQuery = where
      ? `?${where}&record=true&twins=true`
      : '?record=true&twins=true';
    try {
      const [weatherRes, flagsRes] = await Promise.all([
        fetchImpl(`${WEATHER_SAMPLE_URL}${sampleQuery}`),
        fetchImpl(`${WEATHER_FLAGS_URL}${flagsQuery}`),
      ]);
      const weather = weatherRes.ok ? await weatherRes.json() : { catalogStatus: 'unavailable' };
      const flags = flagsRes.ok ? await flagsRes.json() : { catalogStatus: 'unavailable', flags: [], new: [] };
      lastView = formatFlagsView({ weather, flags });
    } catch {
      lastView = formatFlagsView({
        weather: { catalogStatus: 'unavailable' },
        flags: { flags: [], disclaimer: 'World Track unreachable. Not SAFE.' },
      });
    }
    render();
  }

  function render() {
    if (!root) return;
    const status = root.querySelector('[data-weather-flags-status]');
    const list = root.querySelector('[data-weather-flags-list]');
    if (status) status.textContent = statusLine(lastView);
    if (!list) return;
    list.replaceChildren();
    for (const flag of lastView.pending) {
      const row = host.document.createElement('div');
      row.className = `weather-flags-row sev-${String(flag.severity || 'INFO').toLowerCase()}`;
      const label = host.document.createElement('span');
      label.textContent = `${flag.severity} ${flag.kind}`;
      label.title = JSON.stringify(flag.evidence || {});
      const ack = host.document.createElement('button');
      ack.type = 'button';
      ack.textContent = 'ACK';
      ack.dataset.flagId = flag.id;
      ack.dataset.ack = 'acked';
      const dismiss = host.document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'DISMISS';
      dismiss.dataset.flagId = flag.id;
      dismiss.dataset.ack = 'dismissed';
      row.append(label, ack, dismiss);
      list.appendChild(row);
    }
  }

  async function onClick(event) {
    const button = event.target?.closest?.('button[data-flag-id]');
    if (!button) return;
    const id = button.dataset.flagId;
    const state = button.dataset.ack;
    await fetchImpl(`${WEATHER_FLAGS_URL}/${id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    await poll();
  }

  return {
    getView: () => lastView,
    poll,
    render,
    mount(el) {
      root = el;
      if (!root) return;
      root.hidden = false;
      root.addEventListener('click', onClick);
      void poll();
      timer = host.setInterval(() => { void poll(); }, pollMs);
    },
    destroy() {
      if (timer != null) host.clearInterval(timer);
      timer = null;
      if (root) root.removeEventListener('click', onClick);
      root = null;
    },
  };
}

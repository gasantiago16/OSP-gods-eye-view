/**
 * Pure RainViewer radar timeline helpers. No Cesium, no fetch, no DOM.
 *
 * Frame ids are the advertised Unix timestamps from the catalog. Paths are
 * opaque server-side tokens; this module only admits or rejects them.
 */

export const MAX_RADAR_ZOOM = 7;
export const FRAME_STALE_MS = 20 * 60 * 1000;
export const PUBLIC_TILE_TEMPLATE = '/api/weather-radar/tiles/{frame}/{z}/{x}/{y}.png';
export const RADAR_PLAYBACK_MS = 20_000;
export const RADAR_CATALOG_POLL_MS = 60_000;
export const RADAR_OPACITY_PRESETS = Object.freeze([40, 65, 100]);
export const RADAR_DEFAULT_OPACITY = 65;
export const RADAR_PATH_PATTERN = /^\/v2\/radar\/[A-Za-z0-9_-]{1,64}$/;
export const RADAR_FRAME_ID_PATTERN = /^\d{9,10}$/;

/** @param {unknown} path */
export function isSafeRadarPath(path) {
  return typeof path === 'string' && RADAR_PATH_PATTERN.test(path);
}

/** @param {unknown} id */
export function isRadarFrameId(id) {
  return RADAR_FRAME_ID_PATTERN.test(String(id || ''));
}

/**
 * Admit and sort catalog frames. Duplicates keep the first advertised path.
 * @param {unknown} rawFrames
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ id: string, validTime: number, path: string }>}
 */
export function admitRadarFrames(rawFrames, { limit = 24 } = {}) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!Array.isArray(rawFrames) || cap === 0) return [];
  const seen = new Set();
  const frames = [];
  for (const item of rawFrames) {
    const time = Number(item?.time);
    const path = typeof item?.path === 'string' ? item.path.trim() : '';
    if (!Number.isInteger(time) || time <= 0) continue;
    if (!isRadarFrameId(String(time))) continue;
    if (!isSafeRadarPath(path)) continue;
    if (seen.has(time)) continue;
    seen.add(time);
    frames.push({
      id: String(time),
      validTime: time * 1000,
      path,
    });
  }
  frames.sort((a, b) => a.validTime - b.validTime || a.id.localeCompare(b.id));
  return frames.length > cap ? frames.slice(-cap) : frames;
}

/** @param {Array<{ id: string }>} frames */
export function pickLatestFrame(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  return frames[frames.length - 1];
}

/** @param {Array<{ id: string }>} frames @param {unknown} id */
export function frameIndexById(frames, id) {
  const wanted = String(id || '');
  if (!wanted || !Array.isArray(frames)) return -1;
  return frames.findIndex((frame) => frame.id === wanted);
}

/**
 * Next playback index, wrapping to the start. Missing current snaps to latest.
 * @param {Array<{ id: string }>} frames
 * @param {unknown} currentId
 */
export function nextPlaybackIndex(frames, currentId) {
  if (!Array.isArray(frames) || frames.length === 0) return -1;
  const index = frameIndexById(frames, currentId);
  if (index < 0) return frames.length - 1;
  return (index + 1) % frames.length;
}

/** @param {{ validTime: number }|null} frame @param {number} [now] */
export function frameAgeMs(frame, now = Date.now()) {
  if (!frame || !Number.isFinite(frame.validTime)) return null;
  return Math.max(0, now - frame.validTime);
}

/** @param {number|null|undefined} ageMs */
export function formatFrameAge(ageMs) {
  if (!Number.isFinite(ageMs)) return '—';
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  return `${minutes} MIN`;
}

/** @param {{ validTime: number }|null} frame */
export function isFrameStale(frame, now = Date.now(), staleMs = FRAME_STALE_MS) {
  const age = frameAgeMs(frame, now);
  return age != null && age > staleMs;
}

/** @param {number} validTime */
export function formatValidTimeZ(validTime) {
  const date = new Date(validTime);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}Z`;
}

/**
 * Mercator tile coordinate check for RainViewer max zoom 7.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 */
export function isValidRadarTileCoord(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > MAX_RADAR_ZOOM) return false;
  const max = 2 ** z;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < max && y < max;
}

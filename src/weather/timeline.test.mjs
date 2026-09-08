import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitRadarFrames,
  formatFrameAge,
  formatValidTimeZ,
  frameAgeMs,
  frameIndexById,
  isFrameStale,
  isSafeRadarPath,
  isValidRadarTileCoord,
  nextPlaybackIndex,
  pickLatestFrame,
} from './timeline.js';

const SAMPLE = [
  { time: 1788563400, path: '/v2/radar/7fe2a0a30bbf' },
  { time: 1788564000, path: '/v2/radar/a74f57bb1bb3' },
  { time: 1788564600, path: '/v2/radar/dbfb8104caa9' },
];

test('admits sorted unique frames and rejects traversal or missing path/host tokens', () => {
  const frames = admitRadarFrames([
    { time: 1788564600, path: '/v2/radar/dbfb8104caa9' },
    { time: 1788563400, path: '/v2/radar/7fe2a0a30bbf' },
    { time: 1788563400, path: '/v2/radar/duplicate-ignored' },
    { time: 1788564000, path: '/v2/radar/../secret' },
    { time: 1788564000, path: 'https://evil.example/v2/radar/x' },
    { time: 12, path: '/v2/radar/too-short-time' },
    null,
    { time: 1788564000, path: '/v2/radar/a74f57bb1bb3' },
  ]);
  assert.deepEqual(frames.map((frame) => frame.id), ['1788563400', '1788564000', '1788564600']);
  assert.equal(frames[0].path, '/v2/radar/7fe2a0a30bbf');
  assert.equal(isSafeRadarPath('/v2/radar/7fe2a0a30bbf'), true);
  assert.equal(isSafeRadarPath('/v2/radar/../../etc'), false);
});

test('empty, single, twelve, and over-limit catalogs stay bounded', () => {
  assert.deepEqual(admitRadarFrames([]), []);
  assert.deepEqual(admitRadarFrames(null), []);
  const one = admitRadarFrames([SAMPLE[0]]);
  assert.equal(one.length, 1);
  assert.equal(pickLatestFrame(one).id, '1788563400');

  const twelve = Array.from({ length: 12 }, (_, index) => ({
    time: 1788563400 + index * 600,
    path: `/v2/radar/${index.toString(16).padStart(12, '0')}`,
  }));
  assert.equal(admitRadarFrames(twelve).length, 12);

  const extra = [...twelve, { time: 1788570600, path: '/v2/radar/latestframe01' }];
  const capped = admitRadarFrames(extra, { limit: 12 });
  assert.equal(capped.length, 12);
  assert.equal(pickLatestFrame(capped).id, '1788570600');
  assert.equal(capped[0].id, String(1788563400 + 600));
});

test('playback wraps and missing current snaps to latest', () => {
  const frames = admitRadarFrames(SAMPLE);
  assert.equal(nextPlaybackIndex(frames, '1788563400'), 1);
  assert.equal(nextPlaybackIndex(frames, '1788564600'), 0);
  assert.equal(nextPlaybackIndex(frames, 'missing'), 2);
  assert.equal(nextPlaybackIndex([], '1788563400'), -1);
  assert.equal(frameIndexById(frames, '1788564000'), 1);
});

test('age labels and stale detection use the frame valid time', () => {
  const frames = admitRadarFrames(SAMPLE);
  const latest = pickLatestFrame(frames);
  const now = latest.validTime + 12 * 60_000;
  assert.equal(formatFrameAge(frameAgeMs(latest, now)), '12 MIN');
  assert.equal(isFrameStale(latest, now), false);
  assert.equal(isFrameStale(latest, latest.validTime + 21 * 60_000), true);
  assert.equal(formatValidTimeZ(Date.UTC(2026, 8, 4, 18, 50, 0)), '18:50Z');
});

test('tile coordinates accept z0 and z7 and reject z8 or out of range xyz', () => {
  assert.equal(isValidRadarTileCoord(0, 0, 0), true);
  assert.equal(isValidRadarTileCoord(7, 127, 127), true);
  assert.equal(isValidRadarTileCoord(8, 0, 0), false);
  assert.equal(isValidRadarTileCoord(7, 128, 0), false);
  assert.equal(isValidRadarTileCoord(2, -1, 0), false);
});

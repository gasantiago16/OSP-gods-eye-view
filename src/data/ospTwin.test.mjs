import assert from 'node:assert/strict';
import test from 'node:test';

import { OSP_TWIN_LABEL, honestyLines, llaToEcef, positionsFromTwin, validateTwin } from './ospTwin.js';

const twin = {
  schema: 'osp-twin-lla-v1',
  label: OSP_TWIN_LABEL,
  catch: true,
  miss_m: 1057.5,
  samples: [
    { t_s: 0, lat: 25.9971, lon: -97.157, alt_m: 43 },
    { t_s: 1200, lat: 20.8903, lon: -156.4356, alt_m: 284 },
  ],
};

test('boca maui twin is labeled ECI truth and has a catch sample', () => {
  assert.equal(validateTwin(twin), null);
  assert.equal(validateTwin({ ...twin, label: 'RECONSTRUCTED ESTIMATE' }), 'missing OSP ECI TRUTH label');
  const positions = positionsFromTwin({
    Cartesian3: {
      fromDegreesArrayHeights(flat) {
        return flat;
      },
    },
  }, twin.samples);
  assert.deepEqual(positions, [-97.157, 25.9971, 43, -156.4356, 20.8903, 284]);
});

test('honesty readout keeps ECI absent and reports pack, miss, LLA, ECEF', () => {
  const doc = {
    ...twin,
    missionId: 'boca_maui',
    vehicleId: 'starship_v3',
  };
  const lines = honestyLines(doc, doc.samples[1]);
  assert.equal(lines[0], 'OSP ECI TRUTH');
  assert.match(lines[1], /boca_maui \/ starship_v3/);
  assert.match(lines[2], /CATCH miss 1058 m/);
  assert.match(lines[3], /LLA 20\.89030 -156\.43560 284 m/);
  assert.match(lines[4], /ECEF /);
  assert.match(lines[5], /ECI not in pack/);
  const ecef = llaToEcef(0, 0, 0);
  assert.ok(Math.abs(ecef.x - 6378137) < 1);
  assert.ok(Math.abs(ecef.y) < 1);
  assert.ok(Math.abs(ecef.z) < 1);
});

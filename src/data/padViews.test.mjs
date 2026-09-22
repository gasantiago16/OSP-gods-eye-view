import assert from 'node:assert/strict';
import test from 'node:test';

import { PAD_VIEWS, padViewFromToken } from './padViews.js';

test('four pad views match OSP site coordinates', () => {
  assert.deepEqual(Object.keys(PAD_VIEWS), ['boca', 'ksc', 'vafb', 'maui']);
  assert.equal(padViewFromToken('starbase').lat, 25.9971);
  assert.equal(padViewFromToken('kennedy').lon, -80.6041);
  assert.equal(padViewFromToken('vandenberg').lat, 34.6321);
  assert.equal(padViewFromToken('kahului').lon, -156.4305);
  assert.equal(padViewFromToken('nowhere'), null);
});

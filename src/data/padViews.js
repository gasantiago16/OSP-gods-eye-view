/**
 * Saved pad cameras for the Boca→Maui twin demo.
 * Coordinates match OSP launch sites. A `pad=` share token is the short URL.
 */

export const PAD_VIEWS = Object.freeze({
  boca: Object.freeze({
    id: 'boca',
    label: 'BOCA',
    name: 'Starbase',
    lat: 25.9971,
    lon: -97.1570,
    alt: 4500,
    heading: 20,
    pitch: -40,
  }),
  ksc: Object.freeze({
    id: 'ksc',
    label: 'KSC',
    name: 'Kennedy LC-39A',
    lat: 28.6082,
    lon: -80.6041,
    alt: 4500,
    heading: 0,
    pitch: -40,
  }),
  vafb: Object.freeze({
    id: 'vafb',
    label: 'VAFB',
    name: 'Vandenberg SLC-4E',
    lat: 34.6321,
    lon: -120.6106,
    alt: 4500,
    heading: 200,
    pitch: -40,
  }),
  maui: Object.freeze({
    id: 'maui',
    label: 'MAUI',
    name: 'Maui catch',
    lat: 20.8986,
    lon: -156.4305,
    alt: 4500,
    heading: 40,
    pitch: -40,
  }),
});

const ALIASES = Object.freeze({
  boca: 'boca',
  boca_chica: 'boca',
  starbase: 'boca',
  ksc: 'ksc',
  kennedy: 'ksc',
  vafb: 'vafb',
  vandenberg: 'vafb',
  maui: 'maui',
  kahului: 'maui',
});

export function padViewFromToken(token) {
  const key = ALIASES[String(token || '').trim().toLowerCase()];
  return key ? PAD_VIEWS[key] : null;
}

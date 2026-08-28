# OSP-gods-eye-view — intake + riff plan

Private riff of [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT, © 2026 Bilawal Sidhu).
This repo is **not** an upstream GitHub fork: public-repo forks cannot be private.
`origin` = `gasantiago16/OSP-gods-eye-view`. `upstream` = `bilawalsidhu/gods-eye-view`.

**Local:** `C:\Users\gasan\Projects\OSP-gods-eye-view`  
**Sister lab:** OSP / Omniverse Space Program — `C:\Users\gasan\Projects\omni_spaceflight` (`gasantiago16/OSP`)

## What GEV actually is

Vanilla JS + Vite + CesiumJS. Photorealistic globe via **Google Map Tiles API** (required).
The Vite server is also the **key broker**: OpenSky, AIS, FIRMS, TomTom, Launch Library, OpenAI Realtime stay server-side.
Client-exposed by design: `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN` (restrict them; see `SECURITY.md`).

Upstream HEAD at clone: `314a0e1` (2026-08). Node **24.14.x or 26.x**. This machine: Node **24.19.0**.

| Layer | Source | Key |
|-------|--------|-----|
| Photoreal 3D tiles | Google Map Tiles | required |
| Bing / World Terrain | Cesium ion | optional |
| Flights | OpenSky + adsb.lol | optional OAuth (we have it) |
| Military flights | adsb.lol | none |
| Satellites | CelesTrak TLE + `satellite.js` SGP4 | none |
| Space missions | Launch Library 2; ascent is **cinematic** (`RECONSTRUCTED ESTIMATE`) | none |
| Ships | AISStream | optional |
| Quakes / radio / bikeshare / OSM sites | public | none |
| Fires | NASA FIRMS | optional |
| Traffic | TomTom or labeled sim | optional |
| Voice | OpenAI Realtime | optional — **not wired**. OSP Muse keys are a different API. |

Space-mission replay in `src/data/rocketLaunches.js` is a **scripted camera + estimated ascent**, 8–36 s, then an orbit ring. It is not 6DOF, not ECI RK4, not a vehicle pack. That gap is the riff.

## What OSP already owns (do not rebuild)

| Floor | Lives in OSP | Role |
|-------|----------------|------|
| ECI truth | `packages/spaceflight_core` | RK4 / J2 / aero / PTP / CATCH metrics |
| Live sky ingest | `packages/spaceflight_world` + `app/world_track_api` | OpenSky, CelesTrak, LL2, snapshot `:8765` |
| Map3D radar | `web/world-track` (`:5173`) | Google Map3DElement, not Cesium |
| Twin film | Isaac Sim 6 + Cesium for Omniverse | 1:1 pad / hop, not a browser OSINT console |
| Copilot | `spaceflight_copilot` + Muse | ReAct tools over the world index |

World Track **already decided** Map3D over a Kit globe (`docs/WORLD_TRACK_GOOGLE_EARTH_PIVOT.md`). GEV is the CesiumJS browser console we did not write. Keep both. Do not merge the React Map3D shell into this tree.

## Product split (lock this)

```
OSP physics  ──never──►  trajectory / state / CATCH
        │
        ├── World Track (Map3D :5173)     live ATC radar
        ├── this repo (CesiumJS :4173)    GEV cockpit + public layers
        └── Isaac/Cesium Kit              1:1 film
```

Port **4173** is intentional. OSP World Track owns **5173**.

## First features worth adding

Ordered by unique OSP value, not by how flashy they look on a globe GEV already has.

1. **`osp-twins` layer** — load an OSP artifact (CSV/JSON from `artifacts/` or a small exporter) as a Cesium polyline + vehicle. Label it `OSP ECI TRUTH`. First target: Falcon 9 circular-LEO demo, then Boca→Maui PTP. This is the honest replacement for GEV's cinematic launch replay *when we have a twin*.
2. **World Track bridge** — Vite proxy `/api/osp-world` → `127.0.0.1:8765`. Paint OSP-injected multi-pad launches on this globe without copying `spaceflight_world`.
3. **Pad camera recipes** — Boca, KSC, VAFB, Maui catch site from OSP site LLA. Share-link keys so a demo is a URL.
4. **Honesty HUD** — when a contact is an OSP twin, show ECI / ECEF / LLA and pack id. When it is LL2 replay, keep `RECONSTRUCTED ESTIMATE`. Never blur those.

Out of scope until (1) works:

- Rewriting GEV in React/TypeScript
- Wiring Muse into `OPENAI_API_KEY` (Realtime is a different protocol)
- Ships / CCTV / TomTom (GEV already has them; we have no extra signal)
- Declaring L5 or "matches Falcon flight" on a browser overlay

## Run on this Windows box

```powershell
cd C:\Users\gasan\Projects\OSP-gods-eye-view
.\scripts\dev-windows.ps1
```

Opens **http://localhost:4173** (this Windows box binds Vite to IPv6 `::1`; `http://127.0.0.1:4173` will not connect). `.env` is gitignored; it is filled from OSP `secrets/` (Maps, Cesium ion, OpenSky OAuth).

Windows clones must keep **LF** (`.gitattributes`). `core.autocrlf=true` turns GEV source-pin tests red.

```powershell
npm test
```

## Upstream hygiene

```powershell
git fetch upstream
git log HEAD..upstream/main --oneline
```

Prefer rebase of OSP commits onto upstream `main`. Do not PR OSP-only layers upstream unless they are generic and have no twin artifacts.

## License

Upstream MIT **source** stays. Bundled datasets are **not** MIT (TeleGeography NC-SA, OSM ODbL — see `LICENSE`). New OSP files in this repo are MIT, © 2026 gasantiago16, same terms.

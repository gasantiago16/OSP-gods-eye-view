# AGENTS — OSP-gods-eye-view

Private CesiumJS riff of Bilawal Sidhu's God's Eye View for OSP.

**Do not confuse with:** OSP World Track (`omni_spaceflight/web/world-track`, Map3D `:5173`) or Isaac Kit.

## Start

1. [OSP.md](OSP.md) — why this fork exists, product split, first features
2. Upstream [README.md](README.md) — operator UX
3. [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) — GEV runtime contracts (dense, load-bearing)

## Run

```powershell
cd C:\Users\gasan\Projects\OSP-gods-eye-view
.\scripts\dev-windows.ps1
```

http://localhost:4173 — IPv6 localhost on this box (`::1`). `127.0.0.1:4173` does not hit the server. Keys stay in gitignored `.env`.

Node 24.14.x or 26.x (`package.json` engines). This machine uses 24.19.0.

## Secrets

Never commit `.env`. Fill from OSP:

| This `.env` | OSP source |
|-------------|------------|
| `GOOGLE_MAPS_API_KEY` | `omni_spaceflight/secrets/google_maps_api_key` |
| `CESIUM_ION_TOKEN` | `omni_spaceflight/secrets/cesium_ion.token` |
| `OPENSKY_CLIENT_ID` / `SECRET` | `omni_spaceflight/secrets/opensky_credentials.json` |

Voice/HUD use **SpaceXAI** (`XAI_API_KEY`, same account as Graph Hockey). Copy `XAI_API_KEY` + `XAI_BASE_URL` from `Graph_Hockey/.env`. Do **not** copy OSP Muse keys. HUD is `grok-4.6` chat/completions; the mic is `grok-voice-latest`, not grok-4.6.

## Verify

```powershell
npm test
# then the globe: GET http://127.0.0.1:4173 → 200, tiles not black
```

A black planet with a working HUD means the Maps key/referrer/Map Tiles API is wrong — the app did not crash.

## Remotes

- `origin` → `gasantiago16/OSP-gods-eye-view` (private)
- `upstream` → `bilawalsidhu/gods-eye-view` (public MIT)

## Hard rules

1. Physics truth stays in OSP `spaceflight_core`. This repo visualizes.
2. Do not merge World Track's React Map3D shell into this tree.
3. GEV launch replay is cinematic. OSP overlays must say `OSP ECI TRUTH` or not exist.
4. `npm.cmd` on Windows. Bind `localhost`. Port **4173** (5173 is World Track).

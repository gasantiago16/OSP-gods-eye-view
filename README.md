# OSP-gods-eye-view

**What this repo is:** a **riff** of [Bilawal Sidhu’s God’s Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT, © 2026 Bilawal Sidhu), plus OSP-only layers.  
**What this repo is not:** the original globe, a weapons console, ATC, or OSP physics.

Upstream README (Sidhu’s product, including the YouTube series): [`UPSTREAM_README.md`](UPSTREAM_README.md). Credit stays there. Do not treat the 5M-view clips as ours.

## What we added

| Feature | Status | Limit |
|---------|--------|--------|
| **`weather-radar`** | Shipped 2026-09-04 | RainViewer composite on OSM/Bing terrain. Past ~2 hours, ~10 min frames, zoom 7, Universal Blue. Nowcast/IR discontinued. Transparent tiles are **not** clear skies. |
| **Weather flags HUD** | Shipped 2026-09-15 | Proxies OSP World Track (`:8765`) for NOAA MRMS dBZ + human ACK/DISMISS. RainViewer is the picture; flags are not go/no-go. |
| Windows launcher | `.\scripts\dev-windows.ps1` | Binds `http://localhost:4173` (this box is IPv6 `::1`; `127.0.0.1` may fail). |
| HUD / voice | SpaceXAI (xAI), not OpenAI | Key in gitignored `.env` only. |

Weather **does not modify** OSP trajectories. GIBS/nowCOAST satellite imagery is later work.

Sister lab (private): `gasantiago16/OSP` — Python 6DOF core. Public write-up: [osp-architecture](https://github.com/gasantiago16/osp-architecture). World Track Map3D MVP: [world-track](https://github.com/gasantiago16/world-track).

## Clone (no secrets in git)

```powershell
git clone https://github.com/gasantiago16/OSP-gods-eye-view.git
cd OSP-gods-eye-view
copy .env.example .env
# set GOOGLE_MAPS_API_KEY (required). Restrict to http://localhost:*
npm install
npm test
.\scripts\dev-windows.ps1
```

Open **http://localhost:4173**. Enable **weather-radar** in DATA LAYERS (switches Google 3D → OSM so the overlay is actually visible).

`.env` is gitignored. `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` are client-exposed by upstream design — restrict them; do not try to hide them. See `SECURITY.md`.

## License

MIT. Upstream copyright: Bilawal Sidhu (`LICENSE`). OSP additions: gasantiago16 (`NOTICE.md`).

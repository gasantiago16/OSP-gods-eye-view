# Weather on more than the road map

**Status:** Implementing on `feat/weather-on-maps`.  
**Date:** 2026-09-15

## Why it looks like a road map

Shipped radar is a Cesium `ImageryLayer` (RainViewer PNG). That layer is visible only while `viewer.scene.globe.show` is true.

| Stack | Globe shown? | Radar today |
|-------|----------------|-------------|
| `photoreal` (Google 3D, default) | Hidden. 3D Tiles replace the globe. | Invisible. Status `TERRAIN MAP REQUIRED`. |
| `osm` | Yes. This is the only road basemap left. Bing Road was retired. | Visible. **This is what explicit enable switches to.** |
| `bing-aerial` | Yes (needs ion token). | Already allowed by `stackAllowsRadar`. Not chosen on enable. |
| `bing-labels` | Yes (needs ion token). | Same as aerial, with labels. |

`ensureTerrainGlobe` on user/voice/tool enable calls `setMapStack('osm')` whenever the stack is photoreal. So the first time you turn weather on, you always land on the road map even though Bing would show the same tiles on satellite.

Do not set `globe.show = true` under Google 3D. Startup already documents surface/building clipping if both are on.

## What “looks better” means

1. **Basemap:** precip over satellite (Bing Aerial), not streets.
2. **Readability:** Universal Blue is the only 2026 RainViewer public palette. It is tuned for a light map. On dark ocean it needs a different opacity / blend, not a fake color scale.
3. **Honesty:** 3D mode still cannot show this imagery layer. Say so. Offer Aerial. Do not claim the 3D city has radar on the roofs.

GIBS GOES GeoColor is a **satellite photo**, not this radar. Out of this plan.

## Plan

### 1. Prefer aerial, keep OSM as the keyless fallback

On explicit enable while photoreal:

- If Bing Aerial is available (ion token, stack not `aria-disabled`), `setMapStack('bing-aerial')`.
- Else `setMapStack('osm')` as today.

Do not switch if the operator already chose Bing or OSM. Do not steal a later photoreal choice on cockpit exit (that bug is already fixed). Share/local restore still must not change the basemap.

### 2. Let the operator stay on Labels

`bing-labels` already allows radar. No forced hop from Labels to OSM. Chips stay: 3D suspends radar, Aerial and Labels and OSM paint it.

### 3. Readability on satellite, not a new product

- Default opacity on Bing can be lower than on OSM (blue-on-photo vs blue-on-road). One preset table keyed by stack id, still 40/65/100 chips.
- Optional Cesium `alpha` only. Do not recolor PNG in the proxy in v1 (quota, cache, and a legend that would lie).
- Keep single visible frame (no stacked frames that look like heavier rain).

### 4. Photoreal stays a suspend, with a way out

- Status stays `TERRAIN MAP REQUIRED` (or a clearer `3D HIDES RADAR`).
- One control: **Show on Aerial** (same as step 1). No automatic switch when they merely open the layer while already browsing 3D, if we can show the button instead. Explicit enable may still switch; the button is for “I came back to 3D and want the picture again.”
- Do not drape radar as a `GroundPrimitive` on 3D Tiles in this slice. The launch-pad ring does that for one disc. A global tile mosaic classified on photoreal is a separate spike and can clip buildings.

### 5. Tests

- Enable from photoreal + ion available → stack is `bing-aerial`, radar paints, not OSM.
- Enable from photoreal + no ion → OSM, same as now.
- Enable, then user picks photoreal → radar suspends, no second OSM/Bing steal on cockpit exit.
- Labels + radar stays on Labels.
- Snapshot/share without an explicit enable does not change the map.

## Not in this plan

- GIBS / nowCOAST satellite imagery.
- Hawaii MRMS (flags). This is the RainViewer **picture**.
- Painting weather into Map3D (`:5173`).
- Writing OSP trajectories.

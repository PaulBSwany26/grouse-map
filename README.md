# Grouse Cover Finder

A stripped-down hunting map for Michigan ruffed grouse. It pulls the forest data behind MI-Hunt, scores each stand for grouse habitat, and adds timber sales, public land, gated roads, and your onX tracks.

## Run it

```bash
python3 -m http.server 8765   # run from this folder
```

Then open http://localhost:8765. There's no build step and no API keys. Every data source is a public endpoint queried live from the browser.

## On your phone

The app is an installable web app (a PWA) that works with no signal.

- **Save before you go.** Zoom to your hunting area (zoom 11–12 covers a township or two) and tap **Save this area for offline**. It stores every layer's data plus USGS topo tiles down to zoom 16. One zoom-12 view took about 3 minutes and about 55 MB. Any area you've browsed while online also stays available.
- **In the field.** Tap ◎ to track your location. A card shows the stand you're standing in, its score, and whether you're on mapped public land (with a ⚠ warning if not). If you pan away, follow mode pauses; tap ◎ again to re-center, and tap it once more to stop.
- **Offline basemap.** Use **USGS Topo**, the basemap that "Save this area" downloads. Satellite and OpenTopoMap only keep tiles you've already looked at.
- **Install.** On iPhone (Safari), tap Share → Add to Home Screen. On Android (Chrome), use the **Install app** button or the browser menu.

**It has to be served over HTTPS.** Phones only allow GPS, install, and offline caching on secure sites. localhost is the one exception, so on your computer it works as-is. Any free static host works, because the app is just these files:
- **Netlify Drop:** drag the `grouse-map` folder onto https://app.netlify.com/drop.
- **GitHub Pages:** push the folder to a repo and turn on Pages.
- **Cloudflare Pages:** also works.

After changing any file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## How the score works (`habitat.js`)

The defaults come from Midwest grouse research: Gullion (Cloquet, MN), Kubisiak (central WI), Berner (Wexford Co., MI) and Michigan DNR guidance. Each number and its source is in the companion report, **Ruffed Grouse in the Upper Midwest: A Field Reference**, in the section "From research to the app".

- **A stand on its own** tops out at 75. That is young aspen, 6–20 years old.
- **Neighbors within about 330 ft** add or subtract points:
  - alder next door: +15
  - mature aspen next to young aspen: +12 early season, +15 late
  - an upland–lowland transition: +6
  - young conifer next door: +5, late season only
  - mature conifer next door: −5
- **Only the full combination reaches 100:** young aspen beside alder and mature aspen, on a transition.
- **Large young cuts** are scaled down: ×0.9 above 20 acres, ×0.8 above 40, ×0.7 above 80. Gullion found 20-acre cuts produced about 70% as many grouse as 10-acre cuts.
- **Poorly stocked young stands** are scaled down too: ×0.75 for poor stocking, ×0.9 for medium.

You can adjust the weights in the app under **Tune the model**. Changed values show the research default beside them, and **Reset** restores the defaults.

### When was it cut? (age, best evidence first)
1. **Satellite canopy loss** ([Hansen/UMD via Global Forest Watch](https://www.globalforestwatch.org/), 30 m, annual, currently through 2025). `loss.js` reads the loss year from each tile pixel. If at least 25% of a stand lost canopy after its last inventory, the stand is re-aged from that year. This catches stands the inventory hasn't caught up with.
2. **Sold DNR timber sale, no satellite loss yet.** The stand is flagged ⚠ *may be logged now or soon*, with an orange dotted outline.
3. **Cut within the last 2 years.** The stand is flagged as a fresh cut, with a red dashed outline. It is food, not cover, until about year 4–6.
4. **This year's cuts** aren't in the annual data yet. Turn on **Recent satellite photo**: Sentinel-2 imagery at 10 m resolution from the last ~5 months, via Microsoft Planetary Computer. Fresh cuts show as bare, light patches.

**National Forest.** The DNR has no stands on National Forest land. There the app scores USFS regeneration harvests by years since the cut; these have a dashed outline.

### Zoomed out: statewide hotspots
`tools/build_summary.py` runs weekly in GitHub Actions (`.github/workflows/build-summary.yml`). It downloads every DNR stand (about 190,000) and every USFS harvest, works out each one's neighbor flags with shapely, and writes `data/summary.json`. That file holds inputs only: cover, age, stocking, acres and neighbor flags.

The browser scores those rows with your current weights and season and draws a grid. Each square's color is the best stand score inside it, and its opacity shows how many acres of good cover it holds. Tap a square to zoom in.

To rebuild locally:

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install "shapely>=2" numpy certifi
```

```bash
SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python tools/build_summary.py
```

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Forest stands (cover type, age, size/density, forester notes) | `MiHuntStandSymbologyFRDPublic/FeatureServer/0` (MI DNR) | The same data MI-Hunt shows. About 192k stands on State Forest and State Game Areas. Age updates every year |
| Planned and sold DNR timber sales | `Michigan_DNR_Public_Forest_Inventory_Data/FeatureServer/0` | Sale name, status (SOLD / Prospectus / Approved…), proposed start date, written prescription. Joins to stands by `StandID` |
| Completed DNR treatments | `…/FeatureServer/2` | History only. Records stop around 2015, so the app relies on stand age instead |
| DNR timber sale units | `MichiganDNRAdministeredTimberSales/FeatureServer/0` | Includes Good Neighbor Authority sales on National Forest land (not yet used) |
| Bid results and prospectuses | [michigandnr.com/ftp/forestry/tsreports](https://www.michigandnr.com/ftp/forestry/tsreports/) | PDFs only, so not wired in |
| USFS harvests 1991–present | `apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TimberHarvest_01` | Hiawatha, Ottawa and Huron-Manistee |
| USFS reforestation / timber stand improvement | `EDW_SilvicultureReforestation_01`, `EDW_SilvicultureTimberstandImprovement_01` | Planting records (not yet used) |
| Satellite canopy loss by year | Global Forest Watch tiles (Hansen/UMD), year stored in the blue channel | Covers **every owner**. Used per stand as the measured cut year |
| Recent satellite imagery | Sentinel-2 L2A via Microsoft Planetary Computer mosaic API | 10 m, last ~5 months; shows this year's cuts |
| Public land: State Forest, wildlife areas, parks, CFR, HAP, GEMS | MI DNR open data (same filters MI-Hunt uses) | |
| National Forest boundary | `USA_Federal_Lands_2025` | |
| Trails and roads | DNR trails and roads, USFS trails, USFS roads **closed to motor vehicles** | Gated roads are walk-in grouse trails |

## onX

onX has **no public API**. Pulling its parcel or trail layers through private endpoints would break its terms of service, so this app doesn't do that. Instead:

- **onX → here:** export your markups from onX and drag the file onto this map. The Web Map can do it all at once: My Content → Select → Select All → Export → GPX. The phone app exports GPX only. Then tap **Check my flushes** to score every waypoint against the model.
- **Here → onX:** "Export for onX" writes the top spots in view as GPX waypoints or KML shapes. Import them in the onX Web Map (4 MB / 3,000 markup limit). They then sync to your phone for the field.
- **Property lines without onX:** for public land, the layers above are the authoritative boundaries. Private parcels come from each county's GIS or equalization office (often free). Statewide parcels are only available commercially, from vendors such as Regrid.

## Ideas for next steps
- Score Commercial Forest and private land directly from satellite loss years.
- Add a hunting-pressure factor: distance from drivable roads. Kubisiak found nearly all birds were shot within half a mile of a road.
- Detect this year's cuts automatically by comparing Sentinel-2 vegetation index (NDVI) year over year.
- Add a "future hotspots" view: stands sold or cut 2–5 years ago that will peak soon.
- Read the timber sale prospectus PDFs to get cut dates and bid winners.
- Fit the weights to your own flush history once there are enough points.

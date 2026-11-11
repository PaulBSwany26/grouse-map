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

Each DNR stand gets a base score from its **cover type × age**. It then gets **neighbor bonuses** for what lies within about 100 m.

| Factor | Effect |
|---|---|
| Aspen / balsam poplar / birch, 6–15 yrs | 80 (peak) |
| Aspen 3–5 yrs | 45. Suckers aren't dense enough to hide birds yet |
| Aspen 16–20 / 21–25 yrs | 70 / 55 |
| Mature aspen 26–50 yrs | 32 early season, 45 late season (male flower buds are the winter food) |
| Mixed upland deciduous | 0.75 × the aspen curve |
| Lowland shrub (tag alder) | 58 |
| Young northern hardwood / oak / upland shrub | 40–48 |
| Conifer (cedar, spruce/fir, hemlock…) | 15–45. More weight late season as roost and thermal cover |
| Red/jack pine plantations, openings | ≤ 30 |
| Sapling/pole stocking "Medium" / "Poor" | × 0.9 / × 0.75 |
| **Neighbor: conifer cover** | +5 early, +12 late |
| **Neighbor: alder** | +8 (+10 when alder sits next to young aspen) |
| **Neighbor: mixed aspen ages** (young next to mature) | +8 |
| **Neighbor: opening / shrub edge** | +4 |

**Age correction from timber sales.** Sometimes a stand was sold for a cut after its last inventory, so the inventory still lists it as old timber. In that case the app assumes the cut happened and re-ages the stand. The popup says when it did this.

**National Forest.** The DNR has no stand data for National Forest land, so the app scores USFS *regeneration* harvests (clearcut, coppice, seed-tree, overstory removal) by years since the cut. These show with a dashed outline. Thinning and selection cuts score low.

All of these numbers are starting guesses. Tune them in `habitat.js` against the coverts where you actually flush birds.

### Research behind it
- Grouse density in Great Lakes aspen peaks at about 6–15 years after a clearcut. Stem density runs about 12–14k/acre at age 2, 6–8k at age 10, and under 2k after age 25. ([MSU Extension, Forest Types of Michigan: Aspen](https://bluedynamo.msu.edu/uploads/resources/pdfs/forest_types_of_michigan_-_aspen_(e3202-3).pdf); [Ruffed Grouse Society, Managing Aspen](https://ruffedgrousesociety.org/managing-aspen/))
- Interspersion beats any single stand. The recommendation is small 5–20 acre cuts of different ages next to each other ([MI DNR landowner guide, Ruffed Grouse](https://www.dnr.state.mi.us/publications/pdfs/huntingwildlifehabitat/landowners_guide/Species_Mgmt/Ruffed_Grouse.htm)).
- Drumming logs, nests and broods concentrate on alder–aspen edges. Hazel and alder dominate drumming sites. ([Minnesota legislative library report](https://www.lrl.mn.gov/docs/pre2003/other/802955.pdf); [Wisconsin DNR technical bulletins](https://asset.library.wisc.edu/1711.dl/OTFPUA3WGBSFS8B/E/file-f0114.pdf))
- When a cut happens while the leaves are on, the slash keeps its leaves and makes escape cover for 1–3 years (Wisconsin DNR).

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
| Satellite canopy loss by year | Global Forest Watch tiles (Hansen/UMD) | Covers **every owner**, including Commercial Forest and private land |
| Public land: State Forest, wildlife areas, parks, CFR, HAP, GEMS | MI DNR open data (same filters MI-Hunt uses) | |
| National Forest boundary | `USA_Federal_Lands_2025` | |
| Trails and roads | DNR trails and roads, USFS trails, USFS roads **closed to motor vehicles** | Gated roads are walk-in grouse trails |

## onX

onX has **no public API**. Pulling its parcel or trail layers through private endpoints would break its terms of service, so this app doesn't do that. Instead:

- **onX → here:** in the onX Web Map, export your markups (tracks as GPX, shapes as KML) and drag them onto this map. Phone exports are GPX only.
- **Here → onX:** "Export for onX" writes the top spots in view as GPX waypoints or KML shapes. Import them in the onX Web Map (4 MB / 3,000 markup limit). They then sync to your phone for the field.
- **Property lines without onX:** for public land, the layers above are the authoritative boundaries. Private parcels come from each county's GIS or equalization office (often free). Statewide parcels are only available commercially, from vendors such as Regrid.

## Ideas for next steps
- Add neighbor bonuses for USFS cuts and use the satellite loss years to score Commercial Forest land.
- Add a "future hotspots" view: stands sold or cut 2–5 years ago that will peak soon.
- Read the timber sale prospectus PDFs to get cut dates and bid winners.
- Log your flushes, then fit the weights to where you actually find birds.

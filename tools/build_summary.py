#!/usr/bin/env python3
"""
Build data/summary.json: a compact statewide table of every DNR stand (plus USFS
regeneration cuts) for the zoomed-out "hotspot" view.

The browser scores these rows with the same habitat.js model and the user's current
weights, so this file stores *inputs* (cover group, age, stocking, acres, neighbor flags),
not scores.

Runs weekly in GitHub Actions (.github/workflows/build-summary.yml).
Requires: shapely>=2, numpy.
"""
import json, math, sys, time, urllib.parse, urllib.request, datetime, os
from collections import Counter
import numpy as np
import shapely
from shapely.geometry import shape

AGOL = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services"
STANDS = f"{AGOL}/MiHuntStandSymbologyFRDPublic/FeatureServer/0"
TREATMENTS = f"{AGOL}/Michigan_DNR_Public_Forest_Inventory_Data/FeatureServer/0"
EDW = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TimberHarvest_01/MapServer"
NOW = datetime.date.today().year
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "summary.json")

# Must match habitat.js
GROUPS = {
    "aspen": ["Aspen"], "lowAspen": ["Lowland Aspen/Balsam Poplar"], "birch": ["Paper Birch"],
    "mixed": ["Mixed Upland Deciduous", "Upland Mixed Forest", "Lowland Mixed Forest"],
    "hardwood": ["Northern Hardwood"], "oak": ["Oak"], "alder": ["Lowland Shrub"], "shrub": ["Upland Shrub"],
    "lowDecid": ["Lowland Deciduous"],
    "conifer": ["Cedar", "Lowland Conifers", "Lowland Spruce/Fir", "Hemlock", "Upland Spruce/Fir",
                "Upland Conifers", "Tamarack", "White Pine"],
    "pine": ["Red Pine", "Jack Pine", "Natural Mixed Pines", "Planted Mixed Pines"],
    "open": ["Herbaceous Openland", "Low-Density Trees"],
}
GROUP_LIST = ["none"] + list(GROUPS) + ["usfsRegen", "usfsPartial"]
GROUP_OF = {c: g for g, cs in GROUPS.items() for c in cs}
LOWLAND_GROUPS = {"lowAspen", "alder", "lowDecid"}
ASPENISH = {"aspen", "lowAspen", "birch", "mixed", "usfsRegen"}
F = dict(alder=1, matureAspen=2, youngAspen=4, lowland=8, youngConifer=16, matureConifer=32, shrub=64)
NEAR_M = 100  # ~330 ft
REGEN = ("clearcut", "coppice", "seed-tree", "overstory removal", "shelterwood removal", "establishment and removal", "patch")


def get(url, params, tries=4):
    q = urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            req = urllib.request.Request(url + "/query", data=q.encode(), headers={"User-Agent": "grouse-cover-finder"})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:  # noqa
            print("  retry", k + 1, e, file=sys.stderr)
            time.sleep(3 * (k + 1))
    raise RuntimeError("query failed: " + url)


def fetch_all(url, where, fields, order, page=2000, geometry=True, offset_deg=None):
    cache = os.environ.get("SUMMARY_CACHE")  # optional local cache dir to skip re-downloading while developing
    if cache:
        import hashlib
        fn = os.path.join(cache, hashlib.md5(f"{url}|{where}|{fields}".encode()).hexdigest() + ".json")
        if os.path.exists(fn):
            with open(fn) as fh:
                return json.load(fh)
        feats = _fetch_all(url, where, fields, order, page, geometry, offset_deg)
        os.makedirs(cache, exist_ok=True)
        with open(fn, "w") as fh:
            json.dump(feats, fh)
        return feats
    return _fetch_all(url, where, fields, order, page, geometry, offset_deg)


def _fetch_all(url, where, fields, order, page, geometry, offset_deg):
    feats, off = [], 0
    while True:
        p = dict(where=where, outFields=fields, returnGeometry=str(geometry).lower(), outSR=4326, f="geojson",
                 resultOffset=off, resultRecordCount=page, orderByFields=order, geometryPrecision=5)
        if offset_deg:
            p["maxAllowableOffset"] = offset_deg
        d = get(url, p)
        fs = d.get("features", [])
        feats += fs
        more = d.get("exceededTransferLimit") or d.get("properties", {}).get("exceededTransferLimit")
        print(f"  {url.rsplit('/', 3)[-3]}: {len(feats)}", file=sys.stderr)
        if not fs or not more:
            return feats
        off += len(fs)


def est_age(a):
    if (a.get("DominantAge") or 0) > 0:
        return a["DominantAge"]
    if (a.get("FirstOriginYear") or 0) > 1800:
        return NOW - a["FirstOriginYear"]
    s = (a.get("OverallSize") or a.get("SizeDensityDescription") or "").lower()
    return 10 if s.startswith("sapling") else 35 if s.startswith("pole") else 60 if s.startswith(("saw", "log")) else None


def stock_of(sd):
    s = (sd or "").lower()
    if not s.startswith(("sapling", "pole")):
        return 0
    return 3 if "poor" in s else 2 if "medium" in s else 1


def main():
    t0 = time.time()
    print("Fetching DNR stands…", file=sys.stderr)
    stands = fetch_all(STANDS, "1=1",
                       "OBJECTID,StandID,CoverType,DominantAge,FirstOriginYear,SizeDensityDescription,OverallSize,Acres,Date,UplandLowland",
                       "OBJECTID", offset_deg=0.0003)
    print("Fetching sold sales…", file=sys.stderr)
    sales = fetch_all(TREATMENTS, "ProposalStatusShortDesc = 'SOLD' AND TreatmentName LIKE '%Cut%'",
                      "OBJECTID,StandID,ProposedStartDate", "OBJECTID", geometry=False)
    sold = {}
    for f in sales:
        a = f["properties"]
        if a.get("StandID") is None or not a.get("ProposedStartDate"):
            continue
        y = datetime.datetime.fromtimestamp(a["ProposedStartDate"] / 1000, datetime.timezone.utc).year
        sold[a["StandID"]] = max(sold.get(a["StandID"], 0), y)
    print("Fetching USFS harvests…", file=sys.stderr)
    usfs = []
    for lyr in (11, 0, 1):
        usfs += fetch_all(f"{EDW}/{lyr}", f"state_abbr='MI' AND fy_completed >= '{NOW - 30}'",
                          "objectid,activity_name,date_completed,gis_acres", "objectid", offset_deg=0.0003)

    rows, geoms = [], []
    for f in stands:
        a, g = f["properties"], f.get("geometry")
        if not g:
            continue
        grp = GROUP_OF.get(a.get("CoverType"), "none")
        if grp == "none":
            continue
        age = est_age(a)
        ul = a.get("UplandLowland") or ""
        m = (a.get("Date") or "")[-4:]
        inv = int(m) if m.isdigit() else 0
        sale = sold.get(a.get("StandID"), 0)
        sale_flag = 1 if sale and sale >= inv and (age is None or age > NOW - sale + 2) and NOW - sale <= 5 else 0
        rows.append(dict(g=grp, age=age, st=stock_of(a.get("SizeDensityDescription")), ac=a.get("Acres") or 0,
                         low=1 if ul.startswith("Lowland") else 0, tr=1 if "w/" in ul else 0, sale=sale_flag))
        geoms.append(g)
    for f in usfs:
        a, g = f["properties"], f.get("geometry")
        if not g or not a.get("date_completed"):
            continue
        done = datetime.datetime.fromtimestamp(a["date_completed"] / 1000, datetime.timezone.utc).year
        regen = any(k in (a.get("activity_name") or "").lower() for k in REGEN)
        rows.append(dict(g="usfsRegen" if regen else "usfsPartial", age=NOW - done, st=0, ac=a.get("gis_acres") or 0,
                         low=0, tr=0, sale=0))
        geoms.append(g)
    print(f"{len(rows)} rows; building geometry…", file=sys.stderr)

    # Project to a local equal-ish metric frame (Michigan ~45°N) for distance tests
    K = math.cos(math.radians(45))
    polys = []
    for g in geoms:
        try:
            p = shape(g)
            p = shapely.transform(p, lambda c: np.column_stack([c[:, 0] * 111320 * K, c[:, 1] * 110540]))
            if not p.is_valid:
                p = p.buffer(0)
            polys.append(p)
        except Exception:
            polys.append(shapely.Point(0, 0))
    polys = np.array(polys, dtype=object)
    tree = shapely.STRtree(polys)
    pairs = tree.query(polys, predicate="dwithin", distance=NEAR_M)
    print(f"{pairs.shape[1]} neighbor pairs", file=sys.stderr)

    def cls(r):
        g, age = r["g"], r["age"]
        c = 0
        if g == "alder": c |= F["alder"]
        if g in ASPENISH and age is not None and 4 <= age <= 25: c |= F["youngAspen"]
        if g in ("aspen", "lowAspen") and age is not None and 26 <= age <= 70: c |= F["matureAspen"]
        if r["low"] or g in LOWLAND_GROUPS: c |= F["lowland"]
        if g in ("conifer", "pine") and age is not None and age <= 20: c |= F["youngConifer"]
        if g == "conifer" and age is not None and age > 40: c |= F["matureConifer"]
        if g == "shrub": c |= F["shrub"]
        return c
    own = np.array([cls(r) for r in rows], dtype=np.int64)
    flags = np.zeros(len(rows), dtype=np.int64)
    a_idx, b_idx = pairs
    mask = a_idx != b_idx
    np.bitwise_or.at(flags, a_idx[mask], own[b_idx[mask]])

    # Position: a point inside each polygon; fall back to the raw coordinates' mean if repair emptied it
    lng, lat = np.zeros(len(rows)), np.zeros(len(rows))
    for i, p in enumerate(polys):
        if p.is_empty:
            pts = np.array([c for ring in (shape(geoms[i]).exterior.coords if geoms[i]["type"] == "Polygon" else
                                           [xy for poly in shape(geoms[i]).geoms for xy in poly.exterior.coords])
                            for c in [ring]])
            lng[i], lat[i] = pts[:, 0].mean(), pts[:, 1].mean()
        else:
            c = p.point_on_surface()
            lng[i], lat[i] = c.x / (111320 * K), c.y / 110540

    out = dict(
        generated=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
        year=NOW, groups=GROUP_LIST, count=len(rows),
        lat=[int(round(v * 1e4)) for v in lat], lng=[int(round(v * 1e4)) for v in lng],
        g=[GROUP_LIST.index(r["g"]) for r in rows],
        age=[-1 if r["age"] is None else int(r["age"]) for r in rows],
        st=[r["st"] for r in rows],
        ac=[int(round(r["ac"])) for r in rows],
        f=[int(v) for v in flags],
        m=[r["low"] | (r["tr"] << 1) | (r["sale"] << 2) for r in rows],
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {OUT}: {os.path.getsize(OUT) / 1e6:.1f} MB, {len(rows)} rows, {time.time() - t0:.0f}s",
          f"groups={Counter(r['g'] for r in rows).most_common()}", file=sys.stderr)


if __name__ == "__main__":
    main()

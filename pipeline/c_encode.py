"""Workstream C: encode the day's trips into the binary chunks the web app plays.

Reads (from pipeline/out/):
  day.parquet       cleaned trips on the chosen day (workstream A)
  stations.parquet  station names / snapped coords (workstream A)
  routes.parquet    one OSRM route per directed station pair (workstream B)
  data/c/nta2020.geojson  NYC 2020 Neighborhood Tabulation Areas (NYC Open Data
                    dataset 9nt8-h7nd), downloaded on first run; used for the headline.

Writes:
  web/public/data/manifest.json, trips-00.bin .. trips-23.bin, stations.json
  pipeline/out/encode_report.json   sizes, tolerance, sampling, timing
  pipeline/out/encoded_order.parquet  (hour, idx, ride_id): which trip is which
                    record in each chunk, so tests can trace any record to its source
  pipeline/out/headline.json        candidate table + the rule behind the headline

Binary layout (per contract; all little-endian):
  u32 tripCount, u32 vertexCount, u32[tripCount+1] startIndices,
  u16[vertexCount*2] coords (lng,lat quantized over manifest.bbox to 0..65535),
  u16[vertexCount] times (s since HH:00 of the start hour), u8[tripCount] flags
  (bit0 ebike, bit1 member).

Method:
  * Each pair's polyline is decoded once (vectorized decoder), projected to local
    equirectangular metres, Douglas-Peucker simplified (shapely, endpoints kept) and
    its end points reset to the exact snapped station coords.
  * Each trip's times run from its real started_at to its real ended_at, spread
    along the simplified path in proportion to cumulative distance, rounded to
    whole seconds (rounding is monotone, so times stay non-decreasing).
  * Consecutive vertices of a trip that are identical after quantization and time
    rounding are dropped (they carry no information).
  * Trips within a chunk are ordered by started_at, then ride_id.
  * Budget: all chunks <= 25 MB and hours 07-09 + manifest <= 5 MB. If over, the
    simplification tolerance is raised first (5 -> 8 -> 12 -> 16 -> 20 m), and only
    then casual riders are subsampled by a seeded hash of ride_id.
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import time
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import shapely

T_START = time.time()
HERE = Path(__file__).parent
OUT = HERE / "out"
WEB_DATA = HERE.parent / "web" / "public" / "data"
NTA_PATH = HERE / "data" / "c" / "nta2020.geojson"
NTA_URL = "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=500"

TOLERANCES_M = [5.0, 8.0, 12.0, 16.0, 20.0]
CASUAL_RATES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]
BUDGET_TOTAL = 25_000_000
BUDGET_FIRST3 = 5_000_000
FIRST3_HOURS = (7, 8, 9)  # playback starts in the morning rush
SAMPLE_SALT = "circulation-casual-v1"
BBOX_PAD_DEG = 0.0005  # ~50 m

# Local equirectangular projection around NYC (metres per degree at 40.73 N).
LAT0, LNG0 = 40.73, -73.95
KY = 111_132.92 - 559.82 * math.cos(2 * math.radians(LAT0)) + 1.175 * math.cos(4 * math.radians(LAT0))
KX = 111_412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(3 * math.radians(LAT0))


def log(msg: str) -> None:
    print(f"[{time.time() - T_START:6.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- polylines
def decode_polylines(strings: list[str], precision: int = 6) -> tuple[np.ndarray, np.ndarray]:
    """Vectorized Google polyline decoder. Returns (lnglat float64 [N,2], offsets [len+1])."""
    lens = np.fromiter((len(s) for s in strings), dtype=np.int64, count=len(strings))
    b = np.frombuffer("".join(strings).encode("ascii"), dtype=np.uint8).astype(np.int64) - 63
    is_end = (b & 0x20) == 0
    ends = np.flatnonzero(is_end)
    starts = np.concatenate([[0], ends[:-1] + 1])
    value_id = np.repeat(np.arange(len(starts)), ends - starts + 1)
    k = np.arange(len(b)) - starts[value_id]
    val = np.add.reduceat((b & 0x1F) << (5 * k), starts)
    val = np.where(val & 1, ~(val >> 1), val >> 1)
    # values per string: count end flags inside each string's byte range
    byte_off = np.concatenate([[0], np.cumsum(lens)])
    cend = np.concatenate([[0], np.cumsum(is_end)])
    nvals = cend[byte_off[1:]] - cend[byte_off[:-1]]
    assert np.all(nvals % 2 == 0) and np.all(nvals >= 2)
    npts = nvals // 2
    lat_d = val[0::2]
    lng_d = val[1::2]
    pt_off = np.concatenate([[0], np.cumsum(npts)])
    # cumulative sum within each string
    def seg_cumsum(d: np.ndarray) -> np.ndarray:
        c = np.cumsum(d)
        base = np.concatenate([[0], c[pt_off[1:-1] - 1]])
        return c - np.repeat(base, npts)
    scale = 10.0 ** precision
    lat = seg_cumsum(lat_d) / scale
    lng = seg_cumsum(lng_d) / scale
    return np.column_stack([lng, lat]), pt_off


def to_xy(lnglat: np.ndarray) -> np.ndarray:
    return np.column_stack([(lnglat[:, 0] - LNG0) * KX, (lnglat[:, 1] - LAT0) * KY])


def to_lnglat(xy: np.ndarray) -> np.ndarray:
    return np.column_stack([xy[:, 0] / KX + LNG0, xy[:, 1] / KY + LAT0])


def simplify_paths(lnglat: np.ndarray, off: np.ndarray, tol: float,
                   start_ll: np.ndarray, end_ll: np.ndarray):
    """Douglas-Peucker each path at `tol` metres; endpoints reset to station coords.
    Returns (lnglat [M,2], offsets, frac [M]) where frac is cumulative-distance fraction."""
    npath = len(off) - 1
    npts = np.diff(off)
    idx = np.repeat(np.arange(npath), npts)
    lines = shapely.linestrings(to_xy(lnglat), indices=idx)
    simp = shapely.simplify(lines, tol, preserve_topology=False)
    xy, sidx = shapely.get_coordinates(simp, return_index=True)
    snp = np.bincount(sidx, minlength=npath)
    bad = snp < 2  # degenerate (e.g. loops collapsed): fall back to the two endpoints
    if bad.any():
        keep = ~bad[sidx]
        xy, sidx = xy[keep], sidx[keep]
        extra_idx = np.repeat(np.flatnonzero(bad), 2)
        extra_xy = np.empty((len(extra_idx), 2))
        extra_xy[0::2] = to_xy(start_ll[bad])
        extra_xy[1::2] = to_xy(end_ll[bad])
        xy = np.concatenate([xy, extra_xy])
        sidx = np.concatenate([sidx, extra_idx])
        order = np.argsort(sidx, kind="stable")
        xy, sidx = xy[order], sidx[order]
        snp = np.bincount(sidx, minlength=npath)
    soff = np.concatenate([[0], np.cumsum(snp)])
    ll = to_lnglat(xy)
    ll[soff[:-1]] = start_ll
    ll[soff[1:] - 1] = end_ll
    xy = to_xy(ll)
    seg = np.hypot(*np.diff(xy, axis=0).T)
    seg[soff[1:-1] - 1] = 0.0  # no segment across path boundaries
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    cum = cum - np.repeat(cum[soff[:-1]], snp)
    total = np.repeat(cum[soff[1:] - 1], snp)
    pos = np.arange(len(ll)) - np.repeat(soff[:-1], snp)
    lin = pos / np.repeat(np.maximum(snp - 1, 1), snp)
    frac = np.where(total > 0, cum / np.where(total > 0, total, 1.0), lin)
    return ll, soff, frac, int(bad.sum())


# ---------------------------------------------------------------- encoding
def casual_keep(ride_ids: pd.Series, is_member: np.ndarray, rate: float) -> np.ndarray:
    if rate >= 1.0:
        return np.ones(len(ride_ids), dtype=bool)
    h = np.fromiter(
        (int.from_bytes(hashlib.blake2b((SAMPLE_SALT + r).encode(), digest_size=8).digest(), "little")
         for r in ride_ids), dtype=np.uint64, count=len(ride_ids))
    u = (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)
    return is_member | (u < rate)


def build_vertices(trips: pd.DataFrame, ll, soff, frac):
    """Expand trips to vertices. Returns dict of flat arrays, with per-trip offsets."""
    p = trips["pair_idx"].to_numpy()
    n = (soff[p + 1] - soff[p]).astype(np.int64)
    toff = np.concatenate([[0], np.cumsum(n)])
    trip_of = np.repeat(np.arange(len(trips)), n)
    vidx = np.repeat(soff[p], n) + (np.arange(toff[-1]) - np.repeat(toff[:-1], n))
    t0 = trips["t0"].to_numpy()
    t1 = trips["t1"].to_numpy()
    tf = t0[trip_of] + frac[vidx] * (t1 - t0)[trip_of]
    return ll[vidx], tf, trip_of, toff


def quantize(ll: np.ndarray, bbox) -> np.ndarray:
    minx, miny, maxx, maxy = bbox
    qx = np.rint((ll[:, 0] - minx) / (maxx - minx) * 65535)
    qy = np.rint((ll[:, 1] - miny) / (maxy - miny) * 65535)
    assert qx.min() >= 0 and qx.max() <= 65535 and qy.min() >= 0 and qy.max() <= 65535
    return np.column_stack([qx, qy]).astype(np.uint16)


def encode(trips: pd.DataFrame, ll, soff, frac, bbox):
    """Return per-hour dict of arrays ready to write, plus dedupe count."""
    vll, tf, trip_of, toff = build_vertices(trips, ll, soff, frac)
    q = quantize(vll, bbox)
    t = np.rint(tf).astype(np.int64)
    assert t.min() >= 0 and t.max() <= 65535
    first = np.zeros(len(t), dtype=bool)
    first[toff[:-1]] = True
    same = np.zeros(len(t), dtype=bool)
    same[1:] = (q[1:, 0] == q[:-1, 0]) & (q[1:, 1] == q[:-1, 1]) & (t[1:] == t[:-1])
    keep = first | ~same
    dropped = int((~keep).sum())
    q, t, trip_of = q[keep], t[keep], trip_of[keep]
    n = np.bincount(trip_of, minlength=len(trips))
    assert n.min() >= 2
    toff = np.concatenate([[0], np.cumsum(n)])
    hours = trips["hour"].to_numpy()
    flags = (trips["is_ebike"].to_numpy().astype(np.uint8) | (trips["is_member"].to_numpy().astype(np.uint8) << 1))
    chunks = {}
    for h in range(24):
        ti = np.flatnonzero(hours == h)  # trips are pre-sorted by hour, started_at, ride_id
        if len(ti):
            a, b = ti[0], ti[-1] + 1
            assert len(ti) == b - a
            va, vb = toff[a], toff[b]
            chunks[h] = dict(start=(toff[a:b + 1] - va).astype("<u4"), coords=q[va:vb],
                             times=t[va:vb].astype("<u2"), flags=flags[a:b])
        else:
            chunks[h] = dict(start=np.zeros(1, "<u4"), coords=np.zeros((0, 2), np.uint16),
                             times=np.zeros(0, "<u2"), flags=np.zeros(0, np.uint8))
    return chunks, dropped


def chunk_bytes(c) -> bytes:
    nt = len(c["flags"])
    nv = len(c["times"])
    return b"".join([
        np.array([nt, nv], dtype="<u4").tobytes(),
        c["start"].astype("<u4").tobytes(),
        c["coords"].astype("<u2").tobytes(),
        c["times"].astype("<u2").tobytes(),
        c["flags"].astype(np.uint8).tobytes(),
    ])


def chunk_size(c) -> int:
    nt, nv = len(c["flags"]), len(c["times"])
    return 8 + 4 * (nt + 1) + 4 * nv + 2 * nv + nt


# ---------------------------------------------------------------- headline
# Familiar names for groups of 2020 NTAs. NTAs not listed keep their own name.
REGION_GROUPS = {
    "Midtown": ["Midtown-Times Square", "East Midtown-Turtle Bay", "United Nations"],
    "Flatiron & Union Square": ["Midtown South-Flatiron-Union Square"],
    "Chelsea & Hudson Yards": ["Chelsea-Hudson Yards"],
    "the Financial District": ["Financial District-Battery Park City",
                               "The Battery-Governors Island-Ellis Island-Liberty Island"],
    "Tribeca": ["Tribeca-Civic Center"],
    "SoHo": ["SoHo-Little Italy-Hudson Square"],
    "the Upper East Side": ["Upper East Side-Carnegie Hill", "Upper East Side-Lenox Hill-Roosevelt Island",
                            "Upper East Side-Yorkville"],
    "the Upper West Side": ["Upper West Side (Central)", "Upper West Side-Lincoln Square",
                            "Upper West Side-Manhattan Valley"],
    "Harlem": ["Harlem (North)", "Harlem (South)"],
    "East Harlem": ["East Harlem (North)", "East Harlem (South)"],
    "Washington Heights": ["Washington Heights (North)", "Washington Heights (South)"],
    "Williamsburg": ["Williamsburg", "South Williamsburg"],
    "Bed-Stuy": ["Bedford-Stuyvesant (East)", "Bedford-Stuyvesant (West)"],
    "Bushwick": ["Bushwick (East)", "Bushwick (West)"],
    "Crown Heights": ["Crown Heights (North)", "Crown Heights (South)"],
    "Downtown Brooklyn": ["Downtown Brooklyn-DUMBO-Boerum Hill"],
    "Astoria": ["Astoria (Central)", "Astoria (East)-Woodside (North)", "Astoria (North)-Ditmars-Steinway",
                "Old Astoria-Hallets Point"],
    "Long Island City": ["Long Island City-Hunters Point"],
    "Murray Hill & Kips Bay": ["Murray Hill-Kips Bay"],
    "Stuy Town": ["Stuyvesant Town-Peter Cooper Village"],
    "the East Village": ["East Village"],
    "the West Village": ["West Village"],
    "the Lower East Side": ["Lower East Side"],
}
HEADLINE_WINDOW_BINS = 4  # 60-minute windows (4 x 15-min tide bins), sliding by 15 min
HEADLINE_MIN_SMALL_SIDE = 100  # the smaller of arrivals/departures in the window
HEADLINE_MIN_TOTAL = 400  # arrivals + departures in the window
HEADLINE_MIN_HUB_VOLUME = 1000  # the headline itself must be about a busy place


def fmt_clock(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    ampm = "am" if h % 24 < 12 else "pm"
    h12 = h % 12 or 12
    return f"{h12}{ampm}" if m == 0 else f"{h12}:{m:02d}{ampm}"


def fmt_window(b0: int, nb: int) -> str:
    a, b = b0 * 15, (b0 + nb) * 15
    sa, sb = fmt_clock(a), fmt_clock(b)
    if sa[-2:] == sb[-2:]:
        sa = sa[:-2]
    return f"{sa}–{sb}"


def load_ntas():
    if not NTA_PATH.exists():
        NTA_PATH.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-sSfL", "-o", str(NTA_PATH), NTA_URL], check=True)
    fc = json.loads(NTA_PATH.read_text())
    names = [f["properties"]["ntaname"] for f in fc["features"]]
    geoms = [shapely.geometry.shape(f["geometry"]) for f in fc["features"]]
    return names, geoms


def assign_regions(st: pd.DataFrame) -> pd.Series:
    names, geoms = load_ntas()
    tree = shapely.STRtree(geoms)
    pts = shapely.points(st["lng"].to_numpy(), st["lat"].to_numpy())
    pi, gi = tree.query(pts, predicate="within")
    nta = pd.Series([None] * len(st), dtype=object)
    nta.iloc[pi] = [names[g] for g in gi]
    to_group = {n: g for g, ns in REGION_GROUPS.items() for n in ns}
    return nta.map(lambda n: to_group.get(n, n) if n is not None else None), nta


def headline(st: pd.DataFrame, arr: np.ndarray, dep: np.ndarray):
    region, nta = assign_regions(st)
    st = st.assign(region=region, nta=nta)
    rows = []
    W = HEADLINE_WINDOW_BINS
    for reg, g in st.groupby("region"):
        ix = g.index.to_numpy()
        a = arr[ix].sum(axis=0)
        d = dep[ix].sum(axis=0)
        for b0 in range(0, 96 - W + 1):
            A, D = int(a[b0:b0 + W].sum()), int(d[b0:b0 + W].sum())
            small = min(A, D)
            if small < HEADLINE_MIN_SMALL_SIDE or A + D < HEADLINE_MIN_TOTAL:
                continue
            kind = "absorbs" if A >= D else "sends"
            ratio = A / D if A >= D else D / A
            rows.append(dict(region=reg, stations=int(len(ix)), window=fmt_window(b0, W),
                             start_bin=b0, arrivals=A, departures=D, kind=kind,
                             ratio=round(ratio, 3)))
    cand = pd.DataFrame(rows)
    cand["volume"] = cand.arrivals + cand.departures
    # best window per (region, kind), then rank by ratio
    best = (cand.sort_values(["ratio", "volume"], ascending=False)
            .drop_duplicates(["region", "kind"]).reset_index(drop=True))

    def sentence(r) -> str:
        a, b = r["start_bin"] * 15, (r["start_bin"] + W) * 15
        sa, sb = fmt_clock(a), fmt_clock(b)
        if sa[-2:] == sb[-2:]:
            sa = sa[:-2]
        x = f"{r['ratio']:.1f}×"
        if r["kind"] == "absorbs":
            return f"From {sa} to {sb}, {r['region']} absorbs {x} more bikes than it sends out."
        return f"From {sa} to {sb}, {r['region']} sends out {x} more bikes than it takes in."

    best["sentence"] = best.apply(sentence, axis=1)
    hubs = best[best.volume >= HEADLINE_MIN_HUB_VOLUME]
    top = hubs.iloc[0]
    # runner-ups: the headline region's evening flip, the highest ratio of any
    # honest candidate (smaller volume), the next hub, and the evening homecoming.
    picks = []
    def add(df, role):
        df = df[~df.set_index(["region", "kind"]).index.isin(
            [(top.region, top.kind)] + [(p["region"], p["kind"]) for p in picks])]
        if len(df):
            picks.append(dict(df.iloc[0], role=role))
    pm = best[best.start_bin >= 48]
    add(pm[(pm.kind != top.kind) & (pm.region == top.region)], "evening flip of the headline region")
    add(best, "highest ratio of any candidate (below the hub volume)")
    add(hubs, "next hub")
    add(pm[pm.kind == "absorbs"], "evening sink (homecoming)")
    runners = [{k: (v.item() if isinstance(v, np.generic) else v) for k, v in r.items()} for r in picks]
    top_d = {k: (v.item() if isinstance(v, np.generic) else v) for k, v in top.items()}
    unassigned = st[st.region.isna()]
    out = dict(
        source="pipeline/c_encode.py",
        headline=top_d["sentence"],
        chosen=top_d,
        runner_ups=runners,
        rule=dict(
            flow="arrivals = trips ending at the region's stations with ended_at in the window; "
                 "departures = trips starting there with started_at in the window "
                 "(same 15-min binning as stations.json tide; trips within a region count on both sides)",
            window=f"{W * 15}-minute windows sliding in 15-minute steps (a 15-min bin is too noisy "
                   "for a neighbourhood headline; an hour is the honest unit of a rush)",
            threshold=f"window counted only if min(arrivals, departures) >= {HEADLINE_MIN_SMALL_SIDE} "
                      f"and arrivals + departures >= {HEADLINE_MIN_TOTAL}",
            ratio="max(arrivals, departures) / min(...), rounded to one decimal in the sentence",
            pick=f"highest ratio among candidates with arrivals + departures >= {HEADLINE_MIN_HUB_VOLUME} "
                 "in the hour (a headline should be about a place where many bikes move; smaller "
                 "neighbourhoods with higher ratios are listed as runner-ups)",
            regions="stations assigned to NYC 2020 Neighborhood Tabulation Areas (NYC Open Data "
                    "9nt8-h7nd) by point-in-polygon; NTAs grouped into familiar names per "
                    "REGION_GROUPS in c_encode.py, others keep their NTA name",
        ),
        region_groups=REGION_GROUPS,
        stations_unassigned=int(len(unassigned)),
        region_station_counts={k: int(v) for k, v in st.region.value_counts().items()},
        best_per_region_and_direction=best.drop(columns=["sentence"]).to_dict("records"),
        all_candidates=cand.sort_values("ratio", ascending=False).to_dict("records"),
    )
    return out


# ---------------------------------------------------------------- main
def main() -> None:
    con = duckdb.connect()
    trips = con.sql(f"""
        select ride_id, rideable_type, member_casual, started_at, ended_at,
               start_station_id, end_station_id, start_lng, start_lat, end_lng, end_lat,
               is_ebike, is_member
        from '{OUT / "day.parquet"}'
    """).df()
    routes = con.sql(f"select start_station_id, end_station_id, polyline, fallback from '{OUT / 'routes.parquet'}'").df()
    stations = con.sql(f"select id, name, lng, lat from '{OUT / 'stations.parquet'}'").df()
    day = json.loads((OUT / "day.json").read_text())
    date = day["date"]
    log(f"loaded {len(trips):,} trips, {len(routes):,} routes, {len(stations):,} stations")

    midnight = pd.Timestamp(date)
    trips = trips.sort_values(["started_at", "ride_id"]).reset_index(drop=True)
    assert (trips.started_at >= midnight).all() and (trips.started_at < midnight + pd.Timedelta(days=1)).all()
    trips["hour"] = trips.started_at.dt.hour.astype(np.int64)
    base = midnight + pd.to_timedelta(trips["hour"], unit="h")
    trips["t0"] = (trips.started_at - base).dt.total_seconds()
    trips["t1"] = (trips.ended_at - base).dt.total_seconds()
    assert (trips.t1 > trips.t0).all()

    # join to routes (one row per used pair)
    routes["pair_idx"] = np.arange(len(routes))
    trips = trips.merge(routes[["start_station_id", "end_station_id", "pair_idx"]],
                        on=["start_station_id", "end_station_id"], how="left", validate="many_to_one")
    assert trips.pair_idx.notna().all(), "trip without a route"
    trips["pair_idx"] = trips.pair_idx.astype(np.int64)
    trips = trips.sort_values(["hour", "started_at", "ride_id"]).reset_index(drop=True)

    # station endpoint coords per pair, taken from the trips (snapped station medians)
    pe = trips.drop_duplicates("pair_idx").set_index("pair_idx").sort_index()
    used = pe.index.to_numpy()
    start_ll = np.zeros((len(routes), 2))
    end_ll = np.zeros((len(routes), 2))
    has = np.zeros(len(routes), dtype=bool)
    start_ll[used] = pe[["start_lng", "start_lat"]].to_numpy()
    end_ll[used] = pe[["end_lng", "end_lat"]].to_numpy()
    has[used] = True
    log(f"{has.sum():,} of {len(routes):,} route pairs used by the day's trips")

    ll_raw, off_raw = decode_polylines(routes["polyline"].tolist())
    log(f"decoded {len(ll_raw):,} route points")
    # sanity: decoded endpoints match station coords to precision-6 rounding
    ds = np.abs(ll_raw[off_raw[:-1]][has] - start_ll[has]).max()
    de = np.abs(ll_raw[off_raw[1:] - 1][has] - end_ll[has]).max()
    assert ds < 2e-6 and de < 2e-6, (ds, de)
    # unused pairs: use their own decoded endpoints
    start_ll[~has] = ll_raw[off_raw[:-1]][~has]
    end_ll[~has] = ll_raw[off_raw[1:] - 1][~has]

    hist = np.bincount(((trips.started_at - midnight).dt.total_seconds() // 300).astype(int), minlength=288)
    assert len(hist) == 288 and hist.sum() == len(trips)
    totals = dict(trips=int(len(trips)), ebike=int(trips.is_ebike.sum()), member=int(trips.is_member.sum()))

    # ---- budget loop: tolerance first, then casual subsample
    attempts = []
    chosen = None
    simp_cache = {}
    for rate in [1.0] + CASUAL_RATES:
        tols = TOLERANCES_M if rate == 1.0 else [TOLERANCES_M[-1]]
        keep = casual_keep(trips.ride_id, trips.is_member.to_numpy(), rate)
        tsub = trips[keep].reset_index(drop=True)
        for tol in tols:
            if tol not in simp_cache:
                simp_cache[tol] = simplify_paths(ll_raw, off_raw, tol, start_ll, end_ll)
            ll, soff, frac, nbad = simp_cache[tol]
            vll = ll[np.repeat(has, np.diff(soff))]  # vertices of pairs the day uses
            minx, miny = vll.min(axis=0) - BBOX_PAD_DEG
            maxx, maxy = vll.max(axis=0) + BBOX_PAD_DEG
            bbox = [round(float(minx), 5), round(float(miny), 5), round(float(maxx), 5), round(float(maxy), 5)]
            chunks, dropped = encode(tsub, ll, soff, frac, bbox)
            sizes = {h: chunk_size(c) for h, c in chunks.items()}
            total = sum(sizes.values())
            first3 = sum(sizes[h] for h in FIRST3_HOURS)
            att = dict(simplify_m=tol, casual_sample=rate, trips=int(len(tsub)), total_bytes=total,
                       first3_0709_bytes_excl_manifest=first3,
                       vertices=int(sum(len(c["times"]) for c in chunks.values())))
            attempts.append(att)
            log(f"tol={tol}m casual={rate}: total {total / 1e6:.2f} MB, 07-09 {first3 / 1e6:.2f} MB, "
                f"{att['vertices'] / len(tsub):.1f} v/trip, deduped {dropped:,}")
            if total <= BUDGET_TOTAL and first3 + 20_000 <= BUDGET_FIRST3:
                chosen = (tol, rate, tsub, chunks, dropped, bbox, nbad)
                break
        if chosen:
            break
    assert chosen, "budget unreachable"
    tol, rate, tsub, chunks, dropped, bbox, nbad = chosen

    # ---- write chunks
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    names = [f"trips-{h:02d}.bin" for h in range(24)]
    per_hour = []
    for h in range(24):
        data = chunk_bytes(chunks[h])
        assert len(data) == chunk_size(chunks[h])
        (WEB_DATA / names[h]).write_bytes(data)
        per_hour.append(dict(hour=h, file=names[h], bytes=len(data), trips=len(chunks[h]["flags"]),
                             vertices=len(chunks[h]["times"])))
    order = tsub[["hour", "ride_id"]].copy()
    order["idx"] = order.groupby("hour").cumcount()
    order[["hour", "idx", "ride_id"]].to_parquet(OUT / "encoded_order.parquet", index=False)

    # ---- stations + tide
    in_day = pd.unique(pd.concat([trips.start_station_id, trips.end_station_id]))
    sc = pd.concat([
        trips[["start_station_id", "start_lng", "start_lat"]].set_axis(["id", "lng", "lat"], axis=1),
        trips[["end_station_id", "end_lng", "end_lat"]].set_axis(["id", "lng", "lat"], axis=1),
    ]).drop_duplicates()
    assert sc.id.is_unique, "a station has two different snapped coords in the day's trips"
    st = sc.merge(stations[["id", "name"]], on="id", how="left").sort_values("id").reset_index(drop=True)
    assert st.name.notna().all() and len(st) == len(in_day)
    sid = {s: i for i, s in enumerate(st.id)}
    dep_bin = ((trips.started_at - midnight).dt.total_seconds() // 900).astype(int).to_numpy()
    arr_bin = ((trips.ended_at - midnight).dt.total_seconds() // 900).astype(int).to_numpy()
    dep = np.zeros((len(st), 96), dtype=np.int64)
    arr = np.zeros((len(st), 96), dtype=np.int64)
    np.add.at(dep, (trips.start_station_id.map(sid).to_numpy(), dep_bin), 1)
    in_range = arr_bin < 96
    np.add.at(arr, (trips.end_station_id.map(sid).to_numpy()[in_range], arr_bin[in_range]), 1)
    tide = arr - dep
    stations_json = [dict(id=r.id, name=r.name, lng=float(r.lng), lat=float(r.lat), tide=tide[i].tolist())
                     for i, r in enumerate(st.itertuples())]
    (WEB_DATA / "stations.json").write_text(json.dumps(stations_json, separators=(",", ":")))
    log(f"stations.json: {len(st)} stations; {int((~in_range).sum())} arrivals after midnight dropped from tide")

    # ---- headline
    hl = headline(st[["id", "lng", "lat"]], arr, dep)
    hl["tide_note"] = f"{int((~in_range).sum())} arrivals after midnight are outside the 96 bins and not counted"
    (OUT / "headline.json").write_text(json.dumps(hl, indent=1, ensure_ascii=False))
    log(f"headline: {hl['headline']}")

    # ---- manifest
    enc_trips = int(len(tsub))
    manifest = dict(
        date=date,
        bbox=bbox,
        chunks=names,
        histogram=hist.astype(int).tolist(),
        totals=totals,
        headline=hl["headline"],
        encoded=dict(trips=enc_trips, simplify_m=tol, casual_sample=rate,
                     vertices=int(sum(p["vertices"] for p in per_hour))),
        runner_ups=[r["sentence"] for r in hl["runner_ups"]],
        tide_bin_minutes=15,
        source="pipeline/c_encode.py",
    )
    mtext = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False)
    (WEB_DATA / "manifest.json").write_text(mtext)
    msize = len(mtext.encode())

    total = sum(p["bytes"] for p in per_hour)
    report = dict(
        source="pipeline/c_encode.py",
        date=date,
        simplify_m=tol,
        casual_sample=rate,
        budget_measure_used=("tolerance only" if rate == 1.0 else "tolerance raised to max, then casual subsample"),
        degenerate_paths_fallback=nbad,
        deduped_vertices=dropped,
        encoded_trips=enc_trips,
        cleaned_trips=totals["trips"],
        total_vertices=manifest["encoded"]["vertices"],
        mean_vertices_per_trip=round(manifest["encoded"]["vertices"] / enc_trips, 2),
        total_bytes=total,
        manifest_bytes=msize,
        stations_json_bytes=(WEB_DATA / "stations.json").stat().st_size,
        first3={
            "hours_07_09_plus_manifest": sum(per_hour[h]["bytes"] for h in (7, 8, 9)) + msize,
            "hours_00_02_plus_manifest": sum(per_hour[h]["bytes"] for h in (0, 1, 2)) + msize,
            "hours_06_08_plus_manifest": sum(per_hour[h]["bytes"] for h in (6, 7, 8)) + msize,
            "hours_08_10_plus_manifest": sum(per_hour[h]["bytes"] for h in (8, 9, 10)) + msize,
            "worst_any_3_consecutive_plus_manifest": max(
                sum(per_hour[(h + k) % 24]["bytes"] for k in range(3)) for h in range(24)) + msize,
        },
        budget=dict(total_max=BUDGET_TOTAL, first3_max=BUDGET_FIRST3),
        peak_hour=max(per_hour, key=lambda p: p["bytes"]),
        per_hour=per_hour,
        attempts=attempts,
        tide_arrivals_after_midnight_dropped=int((~in_range).sum()),
        elapsed_s=round(time.time() - T_START, 1),
    )
    (OUT / "encode_report.json").write_text(json.dumps(report, indent=1))
    assert total <= BUDGET_TOTAL and report["first3"]["hours_07_09_plus_manifest"] <= BUDGET_FIRST3
    log(f"done: {total / 1e6:.2f} MB total, 07-09+manifest "
        f"{report['first3']['hours_07_09_plus_manifest'] / 1e6:.2f} MB, "
        f"{report['mean_vertices_per_trip']} v/trip, tol {tol} m, casual {rate}")


if __name__ == "__main__":
    main()

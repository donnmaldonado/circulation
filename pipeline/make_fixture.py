"""Emit a Contract-valid synthetic fixture into web/public/fixture/.

~20k synthetic Citi Bike trips over ~420 stations in a Manhattan / Brooklyn /
Queens footprint. Plausible enough to exercise the frontend, tide layer and
scrubber: a two-peak weekday histogram, morning trips biased *into* Midtown /
FiDi and evening trips biased *out of* them (so the tide flips between 08:45
and 18:00), street-like staircase paths that cross the East River only on
bridges, and timestamps spread along each path by cumulative distance.

Run:  cd pipeline && uv run python make_fixture.py

Stress variant (real-data scale, for fps testing; gitignored output):
      uv run python make_fixture.py --trips 140000 --densify 150 --out ../web/public/fixture-dense
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np

SEED = 7
N_TRIPS = 20_000
N_STATIONS = 420
DATE = "2025-06-18"
OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "fixture"

# Metres per degree at NYC latitude.
M_LAT = 111_132.0
M_LNG = 111_320.0 * math.cos(math.radians(40.73))

# --------------------------------------------------------------------------- land
# Rough, slightly inset land polygons (lng, lat). Stations and path vertices
# must fall inside one of them.
MANHATTAN = [
    (-74.0155, 40.7045), (-74.0135, 40.7150), (-74.0115, 40.7280), (-74.0090, 40.7410),
    (-74.0060, 40.7520), (-73.9990, 40.7640), (-73.9920, 40.7740), (-73.9850, 40.7850),
    (-73.9760, 40.7980), (-73.9660, 40.8110), (-73.9540, 40.8120), (-73.9420, 40.8020),
    (-73.9400, 40.7880), (-73.9460, 40.7760), (-73.9600, 40.7590), (-73.9700, 40.7460),
    (-73.9745, 40.7320), (-73.9740, 40.7210), (-73.9790, 40.7120), (-73.9950, 40.7085),
    (-74.0060, 40.7050), (-74.0120, 40.7020),
]
BROOKLYN = [
    (-73.9975, 40.7020), (-73.9850, 40.7040), (-73.9710, 40.7090), (-73.9640, 40.7180),
    (-73.9600, 40.7280), (-73.9570, 40.7360), (-73.9450, 40.7320), (-73.9260, 40.7240),
    (-73.9150, 40.7050), (-73.9120, 40.6850), (-73.9250, 40.6650), (-73.9500, 40.6560),
    (-73.9750, 40.6550), (-73.9920, 40.6640), (-74.0010, 40.6760), (-73.9990, 40.6880),
]
QUEENS = [
    (-73.9565, 40.7415), (-73.9510, 40.7520), (-73.9440, 40.7610), (-73.9340, 40.7710),
    (-73.9220, 40.7760), (-73.9080, 40.7700), (-73.9040, 40.7520), (-73.9150, 40.7420),
    (-73.9350, 40.7385),
]
BOROUGHS = {"MN": MANHATTAN, "BK": BROOKLYN, "QN": QUEENS}
BOROUGH_SHARE = {"MN": 0.56, "BK": 0.33, "QN": 0.11}
# Street-grid rotation (degrees, bearing of the "avenue" axis from north).
GRID_ANGLE = {"MN": 29.0, "BK": 0.0, "QN": 38.0}

# Bridges as [Manhattan-or-first side, far side] polyline, (lng, lat).
BRIDGES = {
    ("MN", "BK"): [
        [(-74.0020, 40.7115), (-73.9960, 40.7060), (-73.9905, 40.7005)],  # Brooklyn Br.
        [(-73.9960, 40.7150), (-73.9900, 40.7070), (-73.9860, 40.7010)],  # Manhattan Br.
        [(-73.9810, 40.7170), (-73.9700, 40.7130), (-73.9600, 40.7100)],  # Williamsburg Br.
    ],
    ("MN", "QN"): [
        [(-73.9620, 40.7590), (-73.9530, 40.7560), (-73.9440, 40.7520)],  # Queensboro Br.
    ],
    ("BK", "QN"): [
        [(-73.9540, 40.7330), (-73.9530, 40.7390), (-73.9520, 40.7440)],  # Pulaski Br.
    ],
}

# Where the commute pulls in the morning.
CBD = {
    "Midtown": (-73.9840, 40.7550, 1300.0),
    "FiDi": (-74.0090, 40.7075, 800.0),
}
NEIGHBORHOODS = [
    ("FiDi", -74.0090, 40.7075), ("Tribeca", -74.0080, 40.7180), ("Chinatown", -73.9970, 40.7160),
    ("LES", -73.9860, 40.7180), ("SoHo", -74.0000, 40.7240), ("Greenwich Village", -73.9990, 40.7330),
    ("East Village", -73.9840, 40.7270), ("Chelsea", -74.0000, 40.7460), ("Flatiron", -73.9900, 40.7410),
    ("Gramercy", -73.9820, 40.7370), ("Murray Hill", -73.9780, 40.7480), ("Midtown", -73.9840, 40.7550),
    ("Hell's Kitchen", -73.9920, 40.7640), ("Midtown East", -73.9720, 40.7560),
    ("Upper West Side", -73.9750, 40.7870), ("Upper East Side", -73.9560, 40.7730),
    ("Harlem", -73.9480, 40.8060), ("Morningside", -73.9620, 40.8060), ("East Harlem", -73.9420, 40.7960),
    ("DUMBO", -73.9880, 40.7030), ("Brooklyn Heights", -73.9940, 40.6960), ("Downtown Brooklyn", -73.9860, 40.6920),
    ("Fort Greene", -73.9750, 40.6880), ("Williamsburg", -73.9570, 40.7110), ("Greenpoint", -73.9510, 40.7290),
    ("Bushwick", -73.9220, 40.6960), ("Bed-Stuy", -73.9420, 40.6870), ("Park Slope", -73.9800, 40.6720),
    ("Prospect Heights", -73.9670, 40.6770), ("Crown Heights", -73.9450, 40.6720),
    ("Carroll Gardens", -73.9950, 40.6800), ("Long Island City", -73.9450, 40.7470), ("Astoria", -73.9230, 40.7650),
]
CROSS_STREETS = [
    "Broadway", "1 Ave", "2 Ave", "3 Ave", "Lexington Ave", "Park Ave", "Madison Ave", "5 Ave",
    "6 Ave", "7 Ave", "8 Ave", "9 Ave", "10 Ave", "Amsterdam Ave", "Columbus Ave", "Bedford Ave",
    "Atlantic Ave", "Myrtle Ave", "Flushing Ave", "Vernon Blvd", "Grand St", "Houston St",
    "Canal St", "Kent Ave", "Court St", "Fulton St", "DeKalb Ave", "Nostrand Ave",
]


def point_in_poly(lng: np.ndarray, lat: np.ndarray, poly) -> np.ndarray:
    """Vectorized even-odd rule."""
    lng = np.asarray(lng, dtype=float)
    lat = np.asarray(lat, dtype=float)
    inside = np.zeros(lng.shape, dtype=bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = (y1 > lat) != (y2 > lat)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
        inside ^= cond & (lng < xint)
    return inside


def on_land(lng, lat, borough: str) -> np.ndarray:
    return point_in_poly(lng, lat, BOROUGHS[borough])


def to_m(lng, lat):
    return np.asarray(lng) * M_LNG, np.asarray(lat) * M_LAT


def dist_m(a, b) -> float:
    return math.hypot((a[0] - b[0]) * M_LNG, (a[1] - b[1]) * M_LAT)


def path_len(pts: np.ndarray) -> np.ndarray:
    d = np.hypot(np.diff(pts[:, 0]) * M_LNG, np.diff(pts[:, 1]) * M_LAT)
    return np.concatenate([[0.0], np.cumsum(d)])


# ----------------------------------------------------------------------- stations
def make_stations(rng: np.random.Generator):
    stations = []
    min_sep = {"MN": 260.0, "BK": 330.0, "QN": 330.0}
    for b, share in BOROUGH_SHARE.items():
        want = int(round(N_STATIONS * share))
        poly = np.array(BOROUGHS[b])
        lo, hi = poly.min(0), poly.max(0)
        got: list[tuple[float, float]] = []
        tries = 0
        while len(got) < want and tries < 200_000:
            tries += 1
            p = rng.uniform(lo, hi)
            if not on_land([p[0]], [p[1]], b)[0]:
                continue
            if any(dist_m(p, q) < min_sep[b] for q in got):
                continue
            got.append((float(p[0]), float(p[1])))
        for lng, lat in got:
            stations.append({"borough": b, "lng": lng, "lat": lat})

    names_seen: dict[str, int] = {}
    for i, s in enumerate(stations):
        hood = min(NEIGHBORHOODS, key=lambda h: dist_m((s["lng"], s["lat"]), (h[1], h[2])))[0]
        s["hood"] = hood
        street = CROSS_STREETS[int(rng.integers(len(CROSS_STREETS)))]
        num = int(rng.integers(1, 120))
        base = f"{hood} · {street} & {num} St"
        k = names_seen.get(base, 0)
        names_seen[base] = k + 1
        s["name"] = base if k == 0 else f"{base} ({k + 1})"
        s["id"] = f"FX{i:04d}"
    return stations


# -------------------------------------------------------------------------- paths
def rot(angle_deg: float):
    a = math.radians(angle_deg)
    # grid unit vectors in metre space: "avenue" axis (bearing a) and "street" axis.
    ave = np.array([math.sin(a), math.cos(a)])
    st = np.array([math.cos(a), -math.sin(a)])
    return ave, st


def staircase(a, b, borough: str, rng: np.random.Generator) -> np.ndarray | None:
    """Grid-aligned zig-zag from a to b (lng,lat), staying on land. None if impossible."""
    ave, st = rot(GRID_ANGLE[borough])
    am = np.array([a[0] * M_LNG, a[1] * M_LAT])
    bm = np.array([b[0] * M_LNG, b[1] * M_LAT])
    d = bm - am
    da, ds = float(d @ ave), float(d @ st)
    for _ in range(6):
        steps = int(rng.integers(1, 4))  # 1..3 stair steps => 3..7 vertices
        # split the avenue & street legs into `steps` random pieces
        fa = np.diff(np.concatenate([[0], np.sort(rng.uniform(0, 1, steps - 1)), [1]]))
        fs = np.diff(np.concatenate([[0], np.sort(rng.uniform(0, 1, steps - 1)), [1]]))
        street_first = rng.random() < 0.5
        pts = [am.copy()]
        cur = am.copy()
        for i in range(steps):
            legs = [ave * da * fa[i], st * ds * fs[i]]
            if street_first:
                legs.reverse()
            for leg in legs:
                if abs(leg[0]) + abs(leg[1]) < 1.0:
                    continue
                cur = cur + leg
                pts.append(cur.copy())
        pts_arr = np.array(pts)
        # small lateral jitter on interior vertices (a few metres) so paths aren't laser-straight
        if len(pts_arr) > 2:
            pts_arr[1:-1] += rng.normal(0, 6, size=(len(pts_arr) - 2, 2))
        pts_arr[-1] = bm
        ll = np.column_stack([pts_arr[:, 0] / M_LNG, pts_arr[:, 1] / M_LAT])
        # check densely sampled points stay on land
        dense = densify(ll, 60.0)
        if on_land(dense[:, 0], dense[:, 1], borough).all():
            return ll
    return None


def densify(ll: np.ndarray, step_m: float) -> np.ndarray:
    out = [ll[0]]
    for p, q in zip(ll[:-1], ll[1:]):
        n = max(1, int(dist_m(p, q) / step_m))
        for k in range(1, n + 1):
            out.append(p + (q - p) * k / n)
    return np.array(out)


def route(sa, sb, rng: np.random.Generator) -> np.ndarray | None:
    a = (sa["lng"], sa["lat"])
    b = (sb["lng"], sb["lat"])
    ba, bb = sa["borough"], sb["borough"]
    if ba == bb:
        return staircase(a, b, ba, rng)
    key = (ba, bb) if (ba, bb) in BRIDGES else (bb, ba)
    flip = key != (ba, bb)
    bridges = BRIDGES[key]
    # choose the bridge minimising total crow-fly distance
    def cost(br):
        e0, e1 = (br[-1], br[0]) if flip else (br[0], br[-1])
        return dist_m(a, e0) + dist_m(e1, b)

    br = min(bridges, key=cost)
    brp = np.array(br[::-1] if flip else br)
    p1 = staircase(a, tuple(brp[0]), ba, rng)
    p2 = staircase(tuple(brp[-1]), b, bb, rng)
    if p1 is None or p2 is None:
        return None
    return np.vstack([p1, brp[1:-1], p2])


# ------------------------------------------------------------------------ demand
def start_time_pdf() -> np.ndarray:
    """Per-second-of-day density with 8-9am and 5-6pm peaks."""
    t = np.arange(86400) / 3600.0
    base = 0.05 + 0.35 * np.clip(np.sin((t - 5.5) / 18.5 * math.pi), 0, None)  # daytime floor
    am = 1.45 * np.exp(-0.5 * ((t - 8.45) / 0.75) ** 2)
    pm = 1.85 * np.exp(-0.5 * ((t - 17.75) / 1.15) ** 2)
    lunch = 0.35 * np.exp(-0.5 * ((t - 12.75) / 1.0) ** 2)
    pdf = base + am + pm + lunch
    pdf[t < 5] *= 0.35
    return pdf / pdf.sum()


def cbd_weight(stations) -> np.ndarray:
    w = np.zeros(len(stations))
    for lng, lat, r in CBD.values():
        d = np.array([dist_m((s["lng"], s["lat"]), (lng, lat)) for s in stations])
        w += np.exp(-0.5 * (d / r) ** 2)
    return np.clip(w, 0, 1)


def main() -> None:
    global N_TRIPS, OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trips", type=int, default=N_TRIPS)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--densify", type=float, default=0.0,
                    help="add a vertex every N metres along paths (mimics real routed vertex counts)")
    args = ap.parse_args()
    N_TRIPS, OUT = args.trips, args.out.resolve()
    rng = np.random.default_rng(SEED)
    OUT.mkdir(parents=True, exist_ok=True)
    stations = make_stations(rng)
    S = len(stations)
    slng = np.array([s["lng"] for s in stations])
    slat = np.array([s["lat"] for s in stations])
    xm, ym = to_m(slng, slat)
    D = np.hypot(xm[:, None] - xm[None, :], ym[:, None] - ym[None, :])  # metres
    cbd = cbd_weight(stations)
    popularity = rng.lognormal(0, 0.45, S)

    # start seconds of day
    pdf = start_time_pdf()
    starts = np.sort(rng.choice(86400, size=int(N_TRIPS * 1.08), p=pdf))

    # how strongly the commute pulls at time t: +1 morning (into CBD), -1 evening (out)
    def commute(tsec: float) -> float:
        h = tsec / 3600.0
        return math.exp(-0.5 * ((h - 8.5) / 1.1) ** 2) - math.exp(-0.5 * ((h - 17.8) / 1.4) ** 2)

    route_cache: dict[tuple[int, int], np.ndarray] = {}
    trips = []  # (start_sec, end_sec, flags, path(N,2), times(N))
    for t0 in starts:
        c = commute(float(t0))
        # origin: morning -> residential (low cbd), evening -> CBD
        ow = popularity * (1 + 3.0 * max(-c, 0) * cbd) * (1 + 1.2 * max(c, 0) * (1 - cbd))
        o = int(rng.choice(S, p=ow / ow.sum()))
        # destination: distance decay + commute pull
        decay = np.exp(-D[o] / 2600.0)
        dw = popularity * decay * (1 + 9.0 * max(c, 0) * cbd) * (1 + 3.0 * max(-c, 0) * (1 - cbd))
        dw[o] = 0
        dw[D[o] < 250] *= 0.1
        d = int(rng.choice(S, p=dw / dw.sum()))
        key = (o, d)
        if key not in route_cache:
            p = route(stations[o], stations[d], rng)
            if p is None:
                continue
            if args.densify > 0:
                p = densify(p, args.densify)
            route_cache[key] = p
        path = route_cache[key]
        cum = path_len(path)
        length = cum[-1]
        ebike = rng.random() < 0.5
        member = rng.random() < 0.78
        speed = (4.6 if ebike else 3.4) * (1.0 if member else 0.82)  # m/s
        dur = length / speed * rng.lognormal(0.05, 0.18) + rng.uniform(30, 150)
        if not member and rng.random() < 0.15:
            dur *= rng.uniform(1.5, 3.0)  # casual detours / sightseeing
        dur = float(np.clip(dur, 61, 3 * 3600 - 1))
        times = t0 + dur * cum / length
        trips.append((int(t0), float(times[-1]), (1 if ebike else 0) | (2 if member else 0), path, times))

    # a few route attempts fail (no on-land staircase); subsample uniformly to exactly N_TRIPS
    keep = np.sort(rng.choice(len(trips), size=min(N_TRIPS, len(trips)), replace=False))
    trips = [trips[i] for i in keep]
    print(f"stations: {S}, trips: {len(trips)}, unique routes: {len(route_cache)}")

    # ------------------------------------------------------------------- encode
    all_pts = np.vstack([p for *_, p, _ in trips])
    pad = 0.002
    bbox = [
        round(float(min(all_pts[:, 0].min(), slng.min())) - pad, 5),
        round(float(min(all_pts[:, 1].min(), slat.min())) - pad, 5),
        round(float(max(all_pts[:, 0].max(), slng.max())) + pad, 5),
        round(float(max(all_pts[:, 1].max(), slat.max())) + pad, 5),
    ]
    minx, miny, maxx, maxy = bbox

    def quant(v, lo, hi):
        return np.clip(np.rint((v - lo) / (hi - lo) * 65535), 0, 65535).astype("<u2")

    chunk_names = []
    total_bytes = 0
    for hh in range(24):
        sel = [tr for tr in trips if tr[0] // 3600 == hh]
        starts_idx = [0]
        coords, times, flags = [], [], []
        for s0, _e, f, path, tt in sel:
            # integer seconds since HH:00, strictly the real start..end; keep monotone
            t_rel = np.rint(tt - hh * 3600).astype(np.int64)
            t_rel = np.maximum.accumulate(t_rel)
            assert t_rel.max() < 65536
            q = np.column_stack([quant(path[:, 0], minx, maxx), quant(path[:, 1], miny, maxy)])
            coords.append(q.reshape(-1))
            times.append(t_rel.astype("<u2"))
            flags.append(f)
            starts_idx.append(starts_idx[-1] + len(path))
        n = len(sel)
        v = starts_idx[-1]
        buf = bytearray()
        buf += struct.pack("<II", n, v)
        buf += np.array(starts_idx, dtype="<u4").tobytes()
        buf += (np.concatenate(coords) if coords else np.zeros(0, "<u2")).astype("<u2").tobytes()
        buf += (np.concatenate(times) if times else np.zeros(0, "<u2")).astype("<u2").tobytes()
        buf += np.array(flags, dtype="u1").tobytes()
        name = f"trips-{hh:02d}.bin"
        (OUT / name).write_bytes(bytes(buf))
        chunk_names.append(name)
        total_bytes += len(buf)

    # ------------------------------------------------------ histogram / totals / tide
    t_start = np.array([tr[0] for tr in trips])
    t_end = np.array([tr[1] for tr in trips])
    fl = np.array([tr[2] for tr in trips])
    histogram = np.bincount(t_start // 300, minlength=288)[:288].astype(int).tolist()

    # station index of each trip start/end (paths start/end exactly on stations)
    coord_to_idx = {(round(s["lng"], 7), round(s["lat"], 7)): i for i, s in enumerate(stations)}
    o_idx = np.array([coord_to_idx[(round(tr[3][0, 0], 7), round(tr[3][0, 1], 7))] for tr in trips])
    d_idx = np.array([coord_to_idx[(round(tr[3][-1, 0], 7), round(tr[3][-1, 1], 7))] for tr in trips])
    dep = np.zeros((S, 96), dtype=int)
    arr = np.zeros((S, 96), dtype=int)
    np.add.at(dep, (o_idx, t_start // 900), 1)
    in_day = t_end < 86400
    np.add.at(arr, (d_idx[in_day], (t_end[in_day] // 900).astype(int)), 1)
    tide = arr - dep

    # headline: Midtown arrivals / departures in the 08:45 bin (plus neighbours for stability)
    mid_lng, mid_lat, mid_r = CBD["Midtown"]
    midtown = np.array([dist_m((s["lng"], s["lat"]), (mid_lng, mid_lat)) < mid_r for s in stations])
    b = 35  # 08:45-09:00
    a_ = arr[midtown, b].sum()
    d_ = max(1, dep[midtown, b].sum())
    ratio = a_ / d_
    headline = f"At 8:45am, Midtown absorbs {ratio:.1f}× more bikes than it sends out."

    # evening flip check
    e = 72  # 18:00-18:15
    ev_ratio = arr[midtown, e].sum() / max(1, dep[midtown, e].sum())
    print(f"midtown stations: {midtown.sum()}  08:45 arr/dep={ratio:.2f}  18:00 arr/dep={ev_ratio:.2f}")
    assert ratio > 1.5 and ev_ratio < 0.8, "tide should flip between morning and evening"

    manifest = {
        "date": DATE,
        "fixture": True,
        "bbox": bbox,
        "chunks": chunk_names,
        "histogram": histogram,
        "totals": {
            "trips": int(len(trips)),
            "ebike": int((fl & 1).sum()),
            "member": int(((fl >> 1) & 1).sum()),
        },
        "headline": headline,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest))
    stations_out = [
        {"id": s["id"], "name": s["name"], "lng": round(s["lng"], 6), "lat": round(s["lat"], 6),
         "tide": tide[i].tolist()}
        for i, s in enumerate(stations)
    ]
    (OUT / "stations.json").write_text(json.dumps(stations_out))

    print(
        f"totals: {manifest['totals']}  ebike={manifest['totals']['ebike'] / len(trips):.0%} "
        f"member={manifest['totals']['member'] / len(trips):.0%}"
    )
    print(f"chunks: {total_bytes / 1e6:.2f} MB total; headline: {headline}")

    verify(OUT, manifest, trips)
    print(f"wrote {OUT}")


# -------------------------------------------------------------------- read-back
def decode_chunk(buf: bytes, bbox):
    n, v = struct.unpack_from("<II", buf, 0)
    off = 8
    starts = np.frombuffer(buf, "<u4", n + 1, off); off += 4 * (n + 1)
    q = np.frombuffer(buf, "<u2", v * 2, off).reshape(-1, 2); off += 2 * v * 2
    t = np.frombuffer(buf, "<u2", v, off); off += 2 * v
    flags = np.frombuffer(buf, "u1", n, off); off += n
    assert off == len(buf), f"trailing bytes: {len(buf) - off}"
    minx, miny, maxx, maxy = bbox
    lng = minx + q[:, 0] / 65535 * (maxx - minx)
    lat = miny + q[:, 1] / 65535 * (maxy - miny)
    return n, v, starts, lng, lat, t, flags


def verify(out: Path, manifest, trips) -> None:
    """Decode chunk 08 back and compare with the source trips (Contract round trip)."""
    hh = 8
    n, v, starts, lng, lat, t, flags = decode_chunk((out / f"trips-{hh:02d}.bin").read_bytes(), manifest["bbox"])
    src = [tr for tr in trips if tr[0] // 3600 == hh]
    assert n == len(src) and starts[0] == 0 and starts[-1] == v
    assert np.all(np.diff(starts) >= 2), "every trip needs >= 2 vertices"
    max_err_m = 0.0
    max_err_t = 0.0
    for i, (s0, e0, f, path, tt) in enumerate(src):
        a, b = starts[i], starts[i + 1]
        err = np.hypot((lng[a:b] - path[:, 0]) * M_LNG, (lat[a:b] - path[:, 1]) * M_LAT).max()
        max_err_m = max(max_err_m, float(err))
        abs_t = hh * 3600 + t[a:b].astype(float)
        max_err_t = max(max_err_t, float(np.abs(abs_t - tt).max()))
        assert np.all(np.diff(t[a:b].astype(int)) >= 0), "times must be monotone"
        assert flags[i] == f
    total = sum(manifest["histogram"])
    assert total == manifest["totals"]["trips"]
    assert len(manifest["histogram"]) == 288 and len(manifest["chunks"]) == 24
    print(f"read-back trips-{hh:02d}.bin OK: {n} trips, {v} vertices, max coord err {max_err_m:.2f} m, "
          f"max time err {max_err_t:.2f} s")
    assert max_err_m < 2.0 and max_err_t <= 1.0


if __name__ == "__main__":
    main()

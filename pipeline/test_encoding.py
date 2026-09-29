"""Round-trip test for workstream C's encoded trip chunks.

Decodes web/public/data/trips-HH.bin independently of c_encode.py (numpy.frombuffer
on the contract layout) and checks:
  * structure of all 24 files: header counts, startIndices monotonic from 0 to
    vertexCount, file length exactly as the layout implies, >= 2 vertices per trip,
    times non-decreasing within each trip, flags match rideable_type/member_casual;
  * 1,000 random encoded trips (seeded) against a reference recomputed from
    day.parquet + routes.parquet (polyline library decode, shapely Douglas-Peucker
    at the manifest's tolerance, float timestamps): every vertex within 2 m, every
    time within 1 s, first/last time within 1 s of real started_at/ended_at, and
    first/last vertex within 2 m of the station coords;
  * manifest contract fields, stations.json (coords identical to trip endpoints,
    tide recomputed), and the Budget (total <= 25 MB; hours 07-09, hours 00-02 and the
    worst 3 consecutive hours, each + manifest, <= 5 MB).
Exits non-zero on any failure.

Run: cd pipeline && uv run python test_encoding.py [--date YYYY-MM-DD]
  --date also checks that manifest.json and out/day.json are that day.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import polyline
import shapely

HERE = Path(__file__).parent
OUT = HERE / "out"
DATA = HERE.parent / "web" / "public" / "data"
N_SAMPLE = 1000
SEED = 20250911
TOL_M, TOL_S = 2.0, 1.0
BUDGET_TOTAL, BUDGET_FIRST3 = 25_000_000, 5_000_000

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)
        print("FAIL:", msg)


def haversine_m(lng1, lat1, lng2, lat2):
    r = 6_371_008.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl, dp = np.radians(lng2 - lng1), p2 - p1
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def read_chunk(path: Path) -> dict:
    buf = path.read_bytes()
    nt, nv = np.frombuffer(buf, "<u4", 2, 0)
    nt, nv = int(nt), int(nv)
    o = 8
    start = np.frombuffer(buf, "<u4", nt + 1, o); o += 4 * (nt + 1)
    coords = np.frombuffer(buf, "<u2", 2 * nv, o).reshape(-1, 2); o += 4 * nv
    times = np.frombuffer(buf, "<u2", nv, o); o += 2 * nv
    flags = np.frombuffer(buf, "u1", nt, o); o += nt
    return dict(nt=nt, nv=nv, start=start, coords=coords, times=times, flags=flags,
                size=len(buf), expected=o)


# independent local projection for the reference path (same method as the encoder)
LAT0, LNG0 = 40.73, -73.95
KY = 111_132.92 - 559.82 * math.cos(2 * math.radians(LAT0)) + 1.175 * math.cos(4 * math.radians(LAT0))
KX = 111_412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(3 * math.radians(LAT0))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=None, help="YYYY-MM-DD the encoded data must be for")
    args = ap.parse_args()
    manifest = json.loads((DATA / "manifest.json").read_text())
    msize = (DATA / "manifest.json").stat().st_size
    minx, miny, maxx, maxy = manifest["bbox"]
    tol = manifest["encoded"]["simplify_m"]
    date = manifest["date"]
    midnight = pd.Timestamp(date)

    con = duckdb.connect()
    day = con.sql(f"select * from '{OUT / 'day.parquet'}'").df()
    order = pd.read_parquet(OUT / "encoded_order.parquet")

    # ---- manifest contract
    day_json = json.loads((OUT / "day.json").read_text())
    check(day_json["date"] == date, f"out/day.json date {day_json['date']} != manifest {date}")
    if args.date:
        check(date == args.date, f"manifest.date {date} != --date {args.date}")
    check(isinstance(manifest.get("generated_at"), str) and manifest["generated_at"].endswith("Z"),
          "manifest.generated_at")
    check(manifest["chunks"] == [f"trips-{h:02d}.bin" for h in range(24)], "manifest.chunks")
    check(len(manifest["histogram"]) == 288, "histogram length")
    hist = np.bincount(((day.started_at - midnight).dt.total_seconds() // 300).astype(int), minlength=288)
    check(manifest["histogram"] == hist.tolist(), "histogram matches cleaned day")
    check(manifest["totals"] == dict(trips=len(day), ebike=int((day.rideable_type == "electric_bike").sum()),
                                     member=int((day.member_casual == "member").sum())), "totals")
    check(isinstance(manifest["headline"], str) and len(manifest["headline"]) > 10, "headline")
    check(minx < maxx and miny < maxy and len(manifest["bbox"]) == 4, "bbox")

    # ---- structure of all 24 files
    chunks = {}
    sizes = {}
    src = day.set_index("ride_id")
    for h in range(24):
        c = read_chunk(DATA / f"trips-{h:02d}.bin")
        chunks[h] = c
        sizes[h] = c["size"]
        s = c["start"]
        check(c["size"] == c["expected"], f"h{h}: file length {c['size']} != layout {c['expected']}")
        check(s[0] == 0 and s[-1] == c["nv"], f"h{h}: startIndices ends")
        check(bool(np.all(np.diff(s.astype(np.int64)) >= 2)), f"h{h}: startIndices monotonic, >=2 vertices/trip")
        t = c["times"].astype(np.int64)
        within = np.ones(len(t) - 1 if len(t) else 0, dtype=bool)
        if len(t):
            within[s[1:-1].astype(np.int64) - 1] = False  # boundaries between trips
            check(bool(np.all(np.diff(t)[within] >= 0)), f"h{h}: times non-decreasing within trips")
        o = order[order.hour == h].sort_values("idx")
        check(len(o) == c["nt"] and (o.idx.to_numpy() == np.arange(c["nt"])).all(), f"h{h}: order map count")
        rs = src.loc[o.ride_id]
        check(bool((rs.started_at.dt.hour == h).all()), f"h{h}: trips start in hour {h}")
        exp_flags = ((rs.rideable_type == "electric_bike").to_numpy().astype(np.uint8)
                     | ((rs.member_casual == "member").to_numpy().astype(np.uint8) << 1))
        check(bool(np.array_equal(exp_flags, c["flags"])), f"h{h}: flags")
        check(bool(np.all(c["flags"] < 4)), f"h{h}: unused flag bits set")
    total_trips = sum(c["nt"] for c in chunks.values())
    check(total_trips == len(order), "order map covers every encoded trip")
    rate = manifest["encoded"]["casual_sample"]
    if rate >= 1.0:
        check(total_trips == len(day), "all cleaned trips encoded when casual_sample == 1")
    check(total_trips == manifest["encoded"]["trips"], "manifest.encoded.trips")

    # ---- budget
    total = sum(sizes.values())
    first3 = sum(sizes[h] for h in (7, 8, 9)) + msize
    first3_00 = sum(sizes[h] for h in (0, 1, 2)) + msize
    worst3 = max(sum(sizes[(h + k) % 24] for k in range(3)) for h in range(24)) + msize
    check(total <= BUDGET_TOTAL, f"budget: total {total} > {BUDGET_TOTAL}")
    check(first3 <= BUDGET_FIRST3, f"budget: hours 07-09 + manifest {first3} > {BUDGET_FIRST3}")
    check(first3_00 <= BUDGET_FIRST3, f"budget: hours 00-02 + manifest {first3_00} > {BUDGET_FIRST3}")
    check(worst3 <= BUDGET_FIRST3, f"budget: worst 3 consecutive hours + manifest {worst3} > {BUDGET_FIRST3}")

    # ---- 1,000 random trips vs reference
    routes = con.sql(f"select start_station_id, end_station_id, polyline from '{OUT / 'routes.parquet'}'").df()
    routes = routes.set_index(["start_station_id", "end_station_id"]).polyline
    rng = np.random.default_rng(SEED)
    pick = order.iloc[rng.choice(len(order), min(N_SAMPLE, len(order)), replace=False)]
    max_d = max_dt = max_end_d = max_t0 = max_t1 = 0.0
    nvert = 0
    for row in pick.itertuples():
        c = chunks[row.hour]
        a, b = int(c["start"][row.idx]), int(c["start"][row.idx + 1])
        q = c["coords"][a:b].astype(np.float64)
        lng = minx + q[:, 0] / 65535 * (maxx - minx)
        lat = miny + q[:, 1] / 65535 * (maxy - miny)
        tt = c["times"][a:b].astype(np.float64)
        tr = src.loc[row.ride_id]
        base = midnight + pd.Timedelta(hours=row.hour)
        t0 = (tr.started_at - base).total_seconds()
        t1 = (tr.ended_at - base).total_seconds()
        # reference path
        pts = np.array(polyline.decode(routes.loc[(tr.start_station_id, tr.end_station_id)], 6))  # (lat, lng)
        xy = np.column_stack([(pts[:, 1] - LNG0) * KX, (pts[:, 0] - LAT0) * KY])
        sxy = shapely.get_coordinates(shapely.simplify(shapely.LineString(xy), tol, preserve_topology=False))
        if len(sxy) < 2:
            sxy = xy[[0, -1]]
        rl = np.column_stack([sxy[:, 0] / KX + LNG0, sxy[:, 1] / KY + LAT0])
        rl[0] = (tr.start_lng, tr.start_lat)
        rl[-1] = (tr.end_lng, tr.end_lat)
        rxy = np.column_stack([(rl[:, 0] - LNG0) * KX, (rl[:, 1] - LAT0) * KY])
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(rxy, axis=0).T))])
        frac = cum / cum[-1] if cum[-1] > 0 else np.linspace(0, 1, len(cum))
        rt = t0 + frac * (t1 - t0)
        # the encoder drops consecutive vertices identical after quantization + rounding
        rq = np.column_stack([np.rint((rl[:, 0] - minx) / (maxx - minx) * 65535),
                              np.rint((rl[:, 1] - miny) / (maxy - miny) * 65535), np.rint(rt)])
        keep = np.ones(len(rq), dtype=bool)
        keep[1:] = np.any(rq[1:] != rq[:-1], axis=1)
        rl, rt = rl[keep], rt[keep]
        if len(rl) != len(lng):
            check(False, f"{row.ride_id}: {len(lng)} vertices, reference {len(rl)}")
            continue
        d = haversine_m(lng, lat, rl[:, 0], rl[:, 1])
        dt = np.abs(tt - rt)
        max_d, max_dt = max(max_d, d.max()), max(max_dt, dt.max())
        e = max(haversine_m(lng[0], lat[0], tr.start_lng, tr.start_lat),
                haversine_m(lng[-1], lat[-1], tr.end_lng, tr.end_lat))
        max_end_d = max(max_end_d, e)
        max_t0, max_t1 = max(max_t0, abs(tt[0] - t0)), max(max_t1, abs(tt[-1] - t1))
        nvert += len(lng)
        check(d.max() <= TOL_M, f"{row.ride_id}: vertex off by {d.max():.2f} m")
        check(dt.max() <= TOL_S, f"{row.ride_id}: time off by {dt.max():.2f} s")
        check(e <= TOL_M, f"{row.ride_id}: endpoint off station by {e:.2f} m")
        check(abs(tt[0] - t0) <= TOL_S and abs(tt[-1] - t1) <= TOL_S, f"{row.ride_id}: start/end time")

    # ---- stations.json
    st = pd.DataFrame(json.loads((DATA / "stations.json").read_text()))
    ends = pd.concat([
        day[["start_station_id", "start_lng", "start_lat"]].set_axis(["id", "lng", "lat"], axis=1),
        day[["end_station_id", "end_lng", "end_lat"]].set_axis(["id", "lng", "lat"], axis=1)]).drop_duplicates()
    m = ends.merge(st, on="id", how="left", suffixes=("", "_st"))
    check(set(st.id) == set(ends.id), "stations.json has exactly the day's stations")
    check(bool(((m.lng == m.lng_st) & (m.lat == m.lat_st)).all()), "station coords identical to trip endpoints")
    check(bool(st.tide.map(len).eq(96).all()), "tide has 96 bins")
    dep = day.groupby(["start_station_id", ((day.started_at - midnight).dt.total_seconds() // 900).astype(int)]).size()
    eb = ((day.ended_at - midnight).dt.total_seconds() // 900).astype(int)
    arr = day[eb < 96].groupby(["end_station_id", eb[eb < 96]]).size()
    tide = np.zeros((len(st), 96), dtype=np.int64)
    idx = {s: i for i, s in enumerate(st.id)}
    for (s, b), n in arr.items():
        tide[idx[s], b] += n
    for (s, b), n in dep.items():
        tide[idx[s], b] -= n
    check(bool(np.array_equal(tide, np.array(st.tide.tolist()))), "tide recomputed matches")

    print()
    print(f"files: 24 chunks, {total_trips:,} trips, {sum(c['nv'] for c in chunks.values()):,} vertices")
    print(f"budget: total {total / 1e6:.2f} MB (<= 25), 07-09+manifest {first3 / 1e6:.2f} MB, "
          f"00-02+manifest {first3_00 / 1e6:.2f} MB, worst 3h+manifest {worst3 / 1e6:.2f} MB (<= 5)")
    print(f"sample: {N_SAMPLE} trips, {nvert:,} vertices; max vertex error {max_d:.3f} m, "
          f"max time error {max_dt:.3f} s, max endpoint-to-station {max_end_d:.3f} m, "
          f"max |t_first - started_at| {max_t0:.3f} s, max |t_last - ended_at| {max_t1:.3f} s")
    print(f"stations.json: {len(st)} stations, tide verified")
    if failures:
        print(f"\nFAILED: {len(failures)} check(s)")
        return 1
    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

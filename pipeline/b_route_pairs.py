"""Workstream B: route every (start_station, end_station) pair against local OSRM (bicycle).

Input : pairs.parquet  start_station_id, end_station_id, start_lng, start_lat, end_lng, end_lat, n
Output: routes.parquet start_station_id, end_station_id, polyline (polyline6, first/last point =
        exact station coords), distance_m (along geometry), duration_s (OSRM), fallback (bool)
        route_fallbacks.csv  pairs that got a straight line, with the reason.

Raw OSRM responses are cached in <out stem>_cache.duckdb keyed by ids + coords, so a rerun only
routes pairs that are missing (transient HTTP errors are not cached, so they are retried).
Fallback rules are applied at assembly time, so changing them never needs a re-route.

Usage: uv run python b_route_pairs.py [--pairs P] [--out O] [--osrm URL] [--concurrency N]
Env:   OSRM_URL (default http://localhost:5055), ROUTE_CONCURRENCY (default 24 parallel requests)
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import polyline
import requests
from tqdm import tqdm

HERE = Path(__file__).resolve().parent
DEFAULT_OSRM = os.environ.get("OSRM_URL") or "http://localhost:5055"
DEFAULT_CONCURRENCY = int(os.environ.get("ROUTE_CONCURRENCY") or 24)

DETOUR_RATIO = 4.0  # route > 4x straight line ...
DETOUR_MIN_M = 2000.0  # ... and > 2 km  => absurd detour
SNAP_MAX_M = 250.0  # station > 250 m from the routed road (e.g. NJ stations: no NJ roads in the extract)
FALLBACK_SPEED_MS = 15 / 3.6  # straight-line fallback duration at 15 km/h
KEY = ["start_station_id", "end_station_id", "start_lng", "start_lat", "end_lng", "end_lat"]

_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
    return s


def route_one(base: str, row: tuple) -> dict:
    """Query OSRM for one pair. Returns a cache record; status 'error' is transient."""
    sid, eid, slng, slat, elng, elat = row
    url = (
        f"{base}/route/v1/bike/{slng:.7f},{slat:.7f};{elng:.7f},{elat:.7f}"
        "?overview=full&geometries=polyline6&steps=false"
    )
    rec = dict(zip(KEY, row), status="error", geometry=None, osrm_distance=None, duration=None)
    for attempt in range(3):
        try:
            r = _session().get(url, timeout=30)
            js = r.json()
            code = js.get("code", f"HTTP{r.status_code}")
            if code == "Ok" and js.get("routes"):
                rt = js["routes"][0]
                rec.update(
                    status="Ok",
                    geometry=rt["geometry"],
                    osrm_distance=float(rt["distance"]),
                    duration=float(rt["duration"]),
                )
                return rec
            if code in ("NoRoute", "NoSegment", "InvalidValue", "InvalidQuery"):
                rec["status"] = code  # deterministic: cache it
                return rec
            rec["status"] = "error"
        except (requests.RequestException, ValueError):
            rec["status"] = "error"
        time.sleep(0.5 * (attempt + 1))
    return rec


def haversine_path_m(lat: np.ndarray, lng: np.ndarray) -> float:
    if len(lat) < 2:
        return 0.0
    la, lo = np.radians(lat), np.radians(lng)
    dla, dlo = np.diff(la), np.diff(lo)
    a = np.sin(dla / 2) ** 2 + np.cos(la[:-1]) * np.cos(la[1:]) * np.sin(dlo / 2) ** 2
    return float((2 * 6371008.8 * np.arcsin(np.sqrt(a))).sum())


def open_cache(path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(path))
    con.execute(
        """CREATE TABLE IF NOT EXISTS cache (
            start_station_id VARCHAR, end_station_id VARCHAR,
            start_lng DOUBLE, start_lat DOUBLE, end_lng DOUBLE, end_lat DOUBLE,
            status VARCHAR, geometry VARCHAR, osrm_distance DOUBLE, duration DOUBLE)"""
    )
    return con


def flush(con, buf: list[dict]) -> None:
    if not buf:
        return
    df = pd.DataFrame(buf)  # noqa: F841  (referenced by duckdb)
    con.execute(
        "INSERT INTO cache SELECT start_station_id, end_station_id, start_lng, start_lat, "
        "end_lng, end_lat, status, geometry, osrm_distance, duration FROM df"
    )
    buf.clear()


def assemble(row) -> tuple[dict, dict | None]:
    """Build the final route record (+ fallback log entry if any) from pair + cached OSRM result."""
    slat, slng, elat, elng = row.start_lat, row.start_lng, row.end_lat, row.end_lng
    straight = haversine_path_m(np.array([slat, elat]), np.array([slng, elng]))
    reason = None
    pts = None
    if row.status != "Ok" or not isinstance(row.geometry, str):
        reason = f"osrm:{row.status if isinstance(row.status, str) else 'missing'}"
    else:
        pts = polyline.decode(row.geometry, 6)
        # force exact station coords as first/last points (OSRM snaps to the road)
        if pts[0] != (round(slat, 6), round(slng, 6)):
            pts.insert(0, (slat, slng))
        else:
            pts[0] = (slat, slng)
        if pts[-1] != (round(elat, 6), round(elng, 6)):
            pts.append((elat, elng))
        else:
            pts[-1] = (elat, elng)
        arr = np.asarray(pts)
        dist = haversine_path_m(arr[:, 0], arr[:, 1])
        snap = max(haversine_path_m(arr[:2, 0], arr[:2, 1]), haversine_path_m(arr[-2:, 0], arr[-2:, 1]))
        if dist > DETOUR_RATIO * straight and dist > DETOUR_MIN_M:
            reason = f"detour:{dist / max(straight, 1):.1f}x"
        elif snap > SNAP_MAX_M:
            reason = f"snap:{snap:.0f}m"
    if reason is None:
        return (
            dict(
                start_station_id=row.start_station_id,
                end_station_id=row.end_station_id,
                polyline=polyline.encode(pts, 6),
                distance_m=dist,
                duration_s=float(row.duration),
                fallback=False,
            ),
            None,
        )
    rec = dict(
        start_station_id=row.start_station_id,
        end_station_id=row.end_station_id,
        polyline=polyline.encode([(slat, slng), (elat, elng)], 6),
        distance_m=straight,
        duration_s=straight / FALLBACK_SPEED_MS,
        fallback=True,
    )
    log = dict(
        start_station_id=row.start_station_id,
        end_station_id=row.end_station_id,
        start_lng=slng,
        start_lat=slat,
        end_lng=elng,
        end_lat=elat,
        n=row.n,
        reason=reason,
        straight_m=round(straight, 1),
        osrm_distance_m=row.osrm_distance,
    )
    return rec, log


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pairs", type=Path, default=HERE / "out" / "pairs.parquet")
    ap.add_argument("--out", type=Path, default=HERE / "out" / "routes.parquet")
    ap.add_argument("--fallbacks", type=Path, default=None, help="default: <out dir>/route_fallbacks.csv")
    ap.add_argument("--cache", type=Path, default=None, help="default: <out dir>/<out stem>_cache.duckdb")
    ap.add_argument("--osrm", default=DEFAULT_OSRM)
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    ap.add_argument("--flush-every", type=int, default=5000)
    args = ap.parse_args()

    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    fb_path = args.fallbacks or out.parent / "route_fallbacks.csv"
    cache_path = args.cache or out.parent / f"{out.stem}_cache.duckdb"

    t0 = time.time()
    pairs = duckdb.sql(f"SELECT * FROM read_parquet('{args.pairs}')").df()
    pairs = pairs.drop_duplicates(["start_station_id", "end_station_id"])
    print(f"pairs: {len(pairs):,} from {args.pairs}")

    # sanity: OSRM reachable
    try:
        requests.get(f"{args.osrm}/route/v1/bike/-73.9857,40.7484;-73.9772,40.7527", timeout=5).raise_for_status()
    except requests.RequestException as e:
        raise SystemExit(f"OSRM not reachable at {args.osrm} ({e}). Start it with ./b_osrm.sh "
                         "(or ./b_osrm.sh restart), or set OSRM_URL.")

    con = open_cache(cache_path)
    con.register("pairs", pairs)
    todo = con.execute(
        """SELECT p.start_station_id, p.end_station_id, p.start_lng, p.start_lat, p.end_lng, p.end_lat
           FROM pairs p ANTI JOIN cache c USING (start_station_id, end_station_id, start_lng, start_lat, end_lng, end_lat)"""
    ).fetchall()
    print(f"cached: {len(pairs) - len(todo):,}  to route: {len(todo):,}  (cache {cache_path.name})")

    t_route = time.time()
    n_err = 0
    if todo:
        buf: list[dict] = []
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = [ex.submit(route_one, args.osrm, row) for row in todo]
            for f in tqdm(as_completed(futs), total=len(futs), unit="pair",
                          mininterval=2 if sys.stderr.isatty() else 30):
                rec = f.result()
                if rec["status"] == "error":
                    n_err += 1  # transient: don't cache, retried on next run
                    continue
                buf.append(rec)
                if len(buf) >= args.flush_every:
                    flush(con, buf)
        flush(con, buf)
    route_elapsed = time.time() - t_route

    # assemble: left join so transient errors surface as fallbacks
    joined = con.execute(
        """SELECT p.*, c.status, c.geometry, c.osrm_distance, c.duration
           FROM pairs p LEFT JOIN (
               SELECT * FROM cache QUALIFY row_number() OVER (PARTITION BY start_station_id, end_station_id,
                   start_lng, start_lat, end_lng, end_lat ORDER BY status = 'Ok' DESC) = 1
           ) c USING (start_station_id, end_station_id, start_lng, start_lat, end_lng, end_lat)"""
    ).df()
    con.close()

    recs, logs = [], []
    for row in joined.itertuples(index=False):
        r, lg = assemble(row)
        recs.append(r)
        if lg:
            logs.append(lg)
    routes = pd.DataFrame(recs)
    routes["distance_m"] = routes["distance_m"].astype("float64")
    routes["duration_s"] = routes["duration_s"].astype("float64")
    routes.to_parquet(out, index=False)
    fb = pd.DataFrame(
        logs,
        columns=[
            "start_station_id", "end_station_id", "start_lng", "start_lat", "end_lng", "end_lat",
            "n", "reason", "straight_m", "osrm_distance_m",
        ],
    ).sort_values("n", ascending=False)
    fb.to_csv(fb_path, index=False)

    total = len(routes)
    nfb = int(routes["fallback"].sum())
    trips_fb = int(fb["n"].sum()) if len(fb) else 0
    elapsed = time.time() - t0
    print("\n=== routing summary ===")
    print(f"total pairs        : {total:,}")
    print(f"with geometry      : {routes['polyline'].notna().sum():,} ({routes['polyline'].notna().mean():.2%})")
    print(f"fallbacks          : {nfb:,} ({nfb / max(total, 1):.3%})  covering {trips_fb:,} trips")
    if len(fb):
        print("  by reason        : " + ", ".join(f"{k}={v}" for k, v in fb["reason"].str.split(":").str[0].value_counts().items()))
    if n_err:
        print(f"transient errors   : {n_err:,} (not cached; rerun to retry)")
    ok = routes[~routes["fallback"]]
    if len(ok):
        print(f"route distance m   : median {ok['distance_m'].median():,.0f}, p99 {ok['distance_m'].quantile(.99):,.0f}")
    print(f"routed this run    : {len(todo):,} in {route_elapsed:.1f}s ({len(todo) / max(route_elapsed, 1e-9):,.0f} pairs/s)")
    print(f"total elapsed      : {elapsed:.1f}s")
    print(f"wrote {out}  and  {fb_path}")


if __name__ == "__main__":
    main()

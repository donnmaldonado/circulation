"""Build the site's data for one day, end to end: "what today looked like one year ago".

Usage:  cd pipeline && uv run python daily.py [--date YYYY-MM-DD]
        (default: today in New York minus one calendar year; Feb 29 -> Feb 28)

Stages (each a standalone script, run with this interpreter; any failure exits non-zero):
  1. ingest   a_ingest.py --date D       Citi Bike monthly file(s) -> data/trips/YYYY-MM.parquet
  2. select   a_select_day.py --date D   clean + snap -> out/day.parquet, pairs.parquet, day.json
  3. route    b_route_pairs.py           OSRM at $OSRM_URL -> out/routes.parquet
                                         (cache: out/routes_cache.duckdb)
  4. encode   c_encode.py --date D       -> web/public/data/{manifest.json, trips-HH.bin, stations.json}
  5. test     test_encoding.py --date D  round trip + budget

OSRM is not started here (see b_osrm.sh). If it is unreachable when routing starts, daily.py
waits up to $OSRM_WAIT seconds (default 30) and then fails.

Env: OSRM_URL (http://localhost:5055), OSRM_WAIT (30), ROUTE_CONCURRENCY (24),
     DUCKDB_MEMORY_LIMIT (60% of RAM), DUCKDB_THREADS (all CPUs).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

import duckdb
import requests

from common import HERE, OUT, add_date_arg, default_date

WEB_DATA = HERE.parent / "web" / "public" / "data"
OSRM_URL = os.environ.get("OSRM_URL") or "http://localhost:5055"
PROBE = "/route/v1/bike/-73.9857,40.7484;-73.9772,40.7527?overview=false"


def osrm_up() -> bool:
    try:
        return requests.get(OSRM_URL + PROBE, timeout=5).status_code == 200
    except requests.RequestException:
        return False


def wait_for_osrm(timeout_s: float) -> None:
    t_end = time.time() + timeout_s
    while not osrm_up():
        if time.time() >= t_end:
            raise SystemExit(
                f"daily: OSRM is not reachable at {OSRM_URL}. Start it first "
                "(cd pipeline && ./b_osrm.sh, or ./b_osrm.sh restart) or set OSRM_URL."
            )
        time.sleep(2)


def run(stage: str, args: list[str], timings: dict[str, float]) -> None:
    print(f"\n=== daily: {stage}: {' '.join(args)}", flush=True)
    t0 = time.time()
    r = subprocess.run([sys.executable, *args], cwd=HERE)
    timings[stage] = time.time() - t0
    if r.returncode != 0:
        raise SystemExit(f"daily: stage '{stage}' failed (exit {r.returncode}) after {timings[stage]:.0f}s")
    print(f"=== daily: {stage} done in {timings[stage]:.1f}s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_date_arg(ap)
    d = ap.parse_args().date or default_date()
    ds = d.isoformat()
    print(f"daily: building {ds} ({d:%A}); OSRM {OSRM_URL}", flush=True)
    if not osrm_up():
        print(f"daily: note: OSRM not reachable yet at {OSRM_URL}; will check again before routing")

    t_all = time.time()
    timings: dict[str, float] = {}
    run("ingest", ["a_ingest.py", "--date", ds], timings)
    run("select", ["a_select_day.py", "--date", ds], timings)
    wait_for_osrm(float(os.environ.get("OSRM_WAIT") or 30))
    run("route", ["b_route_pairs.py"], timings)
    run("encode", ["c_encode.py", "--date", ds], timings)
    run("test", ["test_encoding.py", "--date", ds], timings)

    day = json.loads((OUT / "day.json").read_text())
    rep = json.loads((OUT / "encode_report.json").read_text())
    man = json.loads((WEB_DATA / "manifest.json").read_text())
    fb = duckdb.sql(f"SELECT count(*) FILTER (fallback), count(*) FROM '{OUT / 'routes.parquet'}'").fetchone()
    print("\n=== daily: summary")
    print(f"date          {day['date']} ({day['weekday']}), from {', '.join(day['source_months'])}")
    print(f"trips         {day['raw_trips']:,} raw -> {day['clean_trips']:,} clean "
          f"(dropped {day['dropped']}); {day['stations']:,} stations, {day['unique_pairs']:,} pairs")
    print(f"routes        {fb[1]:,} pairs, {fb[0]:,} straight-line fallbacks")
    print(f"encoded       {rep['encoded_trips']:,} trips, {rep['total_bytes'] / 1e6:.2f} MB, "
          f"simplify {rep['simplify_m']} m, casual sample {rep['casual_sample']}, "
          f"worst 3h {rep['first3']['worst_any_3_consecutive_plus_manifest'] / 1e6:.2f} MB")
    print(f"headline      {man['headline']}")
    print(f"generated_at  {man['generated_at']}")
    print("timings       " + ", ".join(f"{k} {v:.0f}s" for k, v in timings.items())
          + f"; total {time.time() - t_all:.0f}s")


if __name__ == "__main__":
    main()

"""Workstream F ingest: download the months the congestion-pricing chapter needs
(202401-202404 and 202501-202503) and convert each to a slim parquet.

One month at a time: download zip -> extract CSVs -> DuckDB -> parquet -> delete
zip and CSVs. Output: pipeline/data/f/trips_YYYYMM.parquet with columns
started_at, ended_at (TIMESTAMP), start_station_id, end_station_id (VARCHAR),
start_lat, start_lng, end_lat, end_lng (DOUBLE), rideable_type, member_casual.
No cleaning happens here; f_chapter.py applies the shared cleaning rules.

Run: cd pipeline && uv run python f_ingest.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import duckdb

MONTHS = ["202401", "202402", "202403", "202404", "202501", "202502", "202503"]
BASE = "https://s3.amazonaws.com/tripdata/{m}-citibike-tripdata.zip"
DATA = Path(__file__).parent / "data" / "f"


def ingest(month: str) -> None:
    out = DATA / f"trips_{month}.parquet"
    if out.exists():
        print(f"{month}: exists, skipping")
        return
    zpath = DATA / f"{month}.zip"
    work = DATA / f"work_{month}"
    if not zpath.exists():
        print(f"{month}: downloading", flush=True)
        tmp = zpath.with_suffix(".part")
        subprocess.run(["curl", "-sSfL", "--retry", "5", "-o", str(tmp), BASE.format(m=month)], check=True)
        tmp.rename(zpath)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    csvs: list[Path] = []
    with zipfile.ZipFile(zpath) as zf:
        for info in zf.infolist():
            name = info.filename
            if "__MACOSX" in name or not name.lower().endswith(".csv") or "/." in name:
                continue
            target = work / Path(name).name
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            csvs.append(target)
    print(f"{month}: {len(csvs)} csv(s)", flush=True)
    con = duckdb.connect()
    con.execute("SET memory_limit='6GB'; SET threads=4")
    files = ", ".join(f"'{p}'" for p in sorted(csvs))
    con.execute(f"""
        COPY (
          SELECT
            TRY_CAST(started_at AS TIMESTAMP) AS started_at,
            TRY_CAST(ended_at AS TIMESTAMP) AS ended_at,
            NULLIF(start_station_id, '') AS start_station_id,
            NULLIF(end_station_id, '') AS end_station_id,
            TRY_CAST(start_lat AS DOUBLE) AS start_lat,
            TRY_CAST(start_lng AS DOUBLE) AS start_lng,
            TRY_CAST(end_lat AS DOUBLE) AS end_lat,
            TRY_CAST(end_lng AS DOUBLE) AS end_lng,
            rideable_type, member_casual
          FROM read_csv([{files}], all_varchar=true, header=true, union_by_name=true)
        ) TO '{out}' (FORMAT parquet, COMPRESSION zstd)
    """)
    n = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    print(f"{month}: {n:,} rows -> {out.name}", flush=True)
    shutil.rmtree(work)
    zpath.unlink()


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    for m in sys.argv[1:] or MONTHS:
        ingest(m)


if __name__ == "__main__":
    main()

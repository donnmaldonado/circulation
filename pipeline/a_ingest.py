"""Workstream A, step 1: download Citi Bike NYC monthly trip zips and convert each to parquet.

Usage:  cd pipeline && uv run python a_ingest.py [YYYYMM ...]
Default months: 202606 202607 202608.

Per month: download zip -> extract CSVs (skipping __MACOSX and JC- files) -> one parquet at
data/trips/YYYY-MM.parquet (station ids as VARCHAR) -> delete CSVs and zip.
Idempotent: a month whose parquet already exists is skipped entirely.
"""

import shutil
import sys
import zipfile
from pathlib import Path

import duckdb
import requests
from tqdm import tqdm

BASE_URL = "https://s3.amazonaws.com/tripdata"
DATA = Path(__file__).parent / "data"
RAW = DATA / "raw_a"  # per-month scratch; separate from other workstreams' downloads
TRIPS = DATA / "trips"
DEFAULT_MONTHS = ["202606", "202607", "202608"]

COLUMNS = {
    "ride_id": "VARCHAR",
    "rideable_type": "VARCHAR",
    "started_at": "TIMESTAMP",
    "ended_at": "TIMESTAMP",
    "start_station_name": "VARCHAR",
    "start_station_id": "VARCHAR",
    "end_station_name": "VARCHAR",
    "end_station_id": "VARCHAR",
    "start_lat": "DOUBLE",
    "start_lng": "DOUBLE",
    "end_lat": "DOUBLE",
    "end_lng": "DOUBLE",
    "member_casual": "VARCHAR",
}


def download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with open(tmp, "wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc=dest.name) as bar:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                bar.update(len(chunk))
    tmp.rename(dest)


def extract_csvs(zip_path: Path, out_dir: Path) -> list[Path]:
    """Extract every NYC trip CSV (recursing into nested zips) flat into out_dir."""
    out: list[Path] = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            base = Path(name).name
            if info.is_dir() or "__MACOSX" in name or base.startswith(("._", "JC-")):
                continue
            if base.lower().endswith(".csv"):
                target = out_dir / base
                with z.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=1 << 20)
                out.append(target)
            elif base.lower().endswith(".zip"):
                nested = out_dir / base
                with z.open(info) as src, open(nested, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=1 << 20)
                out.extend(extract_csvs(nested, out_dir))
                nested.unlink()
    return out


def convert(csvs: list[Path], dest: Path) -> int:
    con = duckdb.connect()
    con.execute("SET memory_limit='6GB'; SET threads=6;")
    files = [str(p) for p in sorted(csvs)]
    tmp = dest.with_suffix(".parquet.part")
    select = ", ".join(f"CAST({k} AS {v}) AS {k}" for k, v in COLUMNS.items())
    varchar = {k: "VARCHAR" for k, v in COLUMNS.items() if v == "VARCHAR"}
    con.execute(
        f"""
        COPY (
            SELECT {select}
            FROM read_csv({files!r}, header=true, union_by_name=true, types={varchar!r})
        ) TO '{tmp}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 500000)
        """
    )
    n = con.execute(f"SELECT count(*) FROM read_parquet('{tmp}')").fetchone()[0]
    tmp.rename(dest)
    return n


def ingest_month(ym: str) -> None:
    dest = TRIPS / f"{ym[:4]}-{ym[4:]}.parquet"
    if dest.exists():
        print(f"[{ym}] parquet exists, skipping: {dest}")
        return
    month_dir = RAW / ym
    month_dir.mkdir(parents=True, exist_ok=True)
    zip_path = month_dir / f"{ym}-citibike-tripdata.zip"
    if not zip_path.exists():
        download(f"{BASE_URL}/{zip_path.name}", zip_path)
    csvs = extract_csvs(zip_path, month_dir)
    print(f"[{ym}] extracted {len(csvs)} CSVs: {[p.name for p in csvs]}")
    n = convert(csvs, dest)
    print(f"[{ym}] wrote {n:,} rows -> {dest} ({dest.stat().st_size / 1e6:.0f} MB)")
    shutil.rmtree(month_dir)


def main() -> None:
    TRIPS.mkdir(parents=True, exist_ok=True)
    for ym in sys.argv[1:] or DEFAULT_MONTHS:
        ingest_month(ym)


if __name__ == "__main__":
    main()

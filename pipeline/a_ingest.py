"""Workstream A, step 1: download the Citi Bike NYC monthly trip file(s) and convert to parquet.

Usage:  cd pipeline && uv run python a_ingest.py [--date YYYY-MM-DD] [YYYY-MM ...]
  --date D     ingest the months day D needs: D's month, plus the next month if D is the last
               day of its month (files are split by END time) and that file is published.
               Default: today in New York minus one year.
  YYYY-MM ...  ingest exactly these months instead (YYYYMM also accepted).

Per month: find the file in the tripdata bucket -> download zip -> extract CSVs (skipping
__MACOSX and JC- files; recursing into nested zips) -> one parquet at data/trips/YYYY-MM.parquet
(station ids as VARCHAR) -> delete the zip and CSVs. A month whose parquet exists is skipped.

Finding the file: the bucket listing (https://s3.amazonaws.com/tripdata/) is read and the key
chosen in this order: YYYYMM-citibike-tripdata.zip, YYYYMM-citibike-tripdata.csv.zip, any other
YYYYMM*citibike*.zip, then the yearly bundle YYYY-citibike-tripdata.zip (only that month's CSVs
are kept). If the listing can't be read, the monthly names are tried directly.
Only the current CSV schema (ride_id, rideable_type, started_at, ... since Feb 2021) is supported.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import requests
from tqdm import tqdm

from common import DATA, TRIPS, add_date_arg, default_date, duckdb_connect, months_for_day, parquet_path

BASE_URL = "https://s3.amazonaws.com/tripdata"
RAW = DATA / "raw_a"  # per-month scratch, deleted after conversion

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


class NotPublished(Exception):
    pass


# ---------------------------------------------------------------- bucket
def list_bucket() -> list[str] | None:
    """All keys in the tripdata bucket, or None if the listing can't be read."""
    keys: list[str] = []
    marker = ""
    try:
        while True:
            r = requests.get(f"{BASE_URL}/", params={"marker": marker} if marker else None, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.content)
            ns = {"s3": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
            pfx = "s3:" if ns else ""
            page = [k.text for k in root.iter(f"{{{ns['s3']}}}Key" if ns else "Key") if k.text]
            keys.extend(page)
            trunc = root.find(f"{pfx}IsTruncated", ns)
            if trunc is None or trunc.text != "true" or not page:
                return keys
            marker = page[-1]
    except (requests.RequestException, ET.ParseError) as e:
        print(f"bucket listing unavailable ({e}); trying known file names", file=sys.stderr)
        return None


def resolve_key(month: str, keys: list[str] | None) -> tuple[str, bool]:
    """Return (key, is_yearly_bundle) for YYYY-MM, or raise NotPublished."""
    yyyy, mm = month.split("-")
    ym = yyyy + mm
    monthly = [f"{ym}-citibike-tripdata.zip", f"{ym}-citibike-tripdata.csv.zip"]
    if keys is None:
        for k in monthly:
            try:
                if requests.head(f"{BASE_URL}/{k}", timeout=30).status_code == 200:
                    return k, False
            except requests.RequestException:
                pass
        raise NotPublished(f"{month}: none of {monthly} found at {BASE_URL}")
    keyset = set(keys)
    for k in monthly:
        if k in keyset:
            return k, False
    loose = sorted(k for k in keys if re.match(rf"^{ym}[-_ ]?citi\w*[-_ ]tripdata.*\.zip$", k))
    if loose:
        return loose[0], False
    for k in (f"{yyyy}-citibike-tripdata.zip", f"{yyyy}-citibike-tripdata.csv.zip"):
        if k in keyset:
            return k, True
    raise NotPublished(f"{month}: no monthly or yearly Citi Bike file in {BASE_URL}/ (not published yet?)")


def download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                with open(tmp, "wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc=dest.name,
                                                disable=None, mininterval=2) as bar:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                        bar.update(len(chunk))
            if total and tmp.stat().st_size != total:
                raise requests.RequestException(f"short download {tmp.stat().st_size} of {total}")
            tmp.rename(dest)
            return
        except requests.RequestException as e:
            if attempt == 2:
                raise
            print(f"download failed ({e}); retrying", file=sys.stderr)
            time.sleep(5 * (attempt + 1))


# ---------------------------------------------------------------- convert
def extract_csvs(zip_path: Path, out_dir: Path, only: str | None = None) -> list[Path]:
    """Extract every NYC trip CSV (recursing into nested zips) flat into out_dir.
    `only`: keep only top-level entries whose path contains this string (yearly bundles)."""
    out: list[Path] = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            base = Path(name).name
            if info.is_dir() or "__MACOSX" in name or base.startswith(("._", "JC-")):
                continue
            if only and only not in name:
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


def check_schema(csvs: list[Path]) -> None:
    for p in csvs:
        with open(p, encoding="utf-8", errors="replace") as f:
            header = {h.strip().strip('"') for h in f.readline().strip().split(",")}
        missing = set(COLUMNS) - header
        if missing:
            raise SystemExit(
                f"{p.name}: missing columns {sorted(missing)}. Only the post-2021 Citi Bike schema "
                "is supported (older files use starttime/stoptime/usertype)."
            )


def convert(csvs: list[Path], dest: Path) -> int:
    con = duckdb_connect()
    con.execute("SET preserve_insertion_order=false;")
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
    con.close()
    tmp.rename(dest)
    return n


def ingest_month(month: str, keys: list[str] | None) -> Path:
    """Make sure data/trips/YYYY-MM.parquet exists. Raises NotPublished if the file isn't out."""
    dest = parquet_path(month)
    if dest.exists():
        print(f"[{month}] parquet exists, skipping: {dest}")
        return dest
    key, yearly = resolve_key(month, keys)
    scratch = RAW / month
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)
    try:
        zip_path = scratch / Path(key).name.replace(" ", "_")
        print(f"[{month}] downloading {BASE_URL}/{key}")
        download(f"{BASE_URL}/{requests.utils.quote(key)}", zip_path)
        csvs = extract_csvs(zip_path, scratch, only=month.replace("-", "") if yearly else None)
        zip_path.unlink()
        if not csvs:
            raise SystemExit(f"[{month}] no trip CSVs found in {key}")
        print(f"[{month}] extracted {len(csvs)} CSVs: {[p.name for p in csvs]}")
        check_schema(csvs)
        n = convert(csvs, dest)
        print(f"[{month}] wrote {n:,} rows -> {dest} ({dest.stat().st_size / 1e6:.0f} MB)")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return dest


def ingest_for_day(d) -> list[str]:
    """Ingest the months day d needs. Returns the months available locally (first = d's month).
    The following month (only needed for a month-end day) is optional."""
    months = months_for_day(d)
    keys = None if all(parquet_path(m).exists() for m in months) else list_bucket()
    got = []
    for i, m in enumerate(months):
        try:
            ingest_month(m, keys)
            got.append(m)
        except NotPublished as e:
            if i == 0:
                raise SystemExit(f"cannot ingest {d}: {e}")
            print(f"note: {e}; trips of {d} that end after midnight will be missing")
    return got


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_date_arg(ap)
    ap.add_argument("months", nargs="*", help="YYYY-MM months to ingest instead of --date")
    args = ap.parse_args()
    TRIPS.mkdir(parents=True, exist_ok=True)
    if args.months:
        if args.date:
            ap.error("give --date or months, not both")
        keys = None
        for m in args.months:
            m = m if "-" in m else f"{m[:4]}-{m[4:]}"
            if not re.fullmatch(r"\d{4}-\d{2}", m):
                ap.error(f"bad month {m!r}")
            if keys is None and not parquet_path(m).exists():
                keys = list_bucket()
            try:
                ingest_month(m, keys)
            except NotPublished as e:
                raise SystemExit(str(e))
    else:
        d = args.date or default_date()
        print(f"ingest for {d}: months {ingest_for_day(d)}")


if __name__ == "__main__":
    main()

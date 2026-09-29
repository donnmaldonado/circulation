"""Shared helpers for the pipeline: the target date, the months it needs, and DuckDB sizing.

Environment:
  DUCKDB_MEMORY_LIMIT  e.g. "8GB" (default: 60% of physical RAM)
  DUCKDB_THREADS       e.g. "4"   (default: all CPUs)
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
TRIPS = DATA / "trips"  # one parquet per Citi Bike monthly file: YYYY-MM.parquet
OUT = HERE / "out"
NYC_TZ = "America/New_York"


# ---------------------------------------------------------------- dates
def year_ago(today: dt.date) -> dt.date:
    """The same calendar day one year earlier; Feb 29 maps to Feb 28."""
    try:
        return today.replace(year=today.year - 1)
    except ValueError:  # Feb 29
        return today.replace(year=today.year - 1, day=28)


def nyc_today() -> dt.date:
    from zoneinfo import ZoneInfo

    return dt.datetime.now(ZoneInfo(NYC_TZ)).date()


def default_date() -> dt.date:
    """Today in New York, minus one calendar year."""
    return year_ago(nyc_today())


def parse_date(s: str) -> dt.date:
    try:
        return dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {s!r}") from e


def add_date_arg(ap: argparse.ArgumentParser, default_help: str = "today in New York minus one year") -> None:
    ap.add_argument("--date", type=parse_date, default=None, help=f"YYYY-MM-DD (default: {default_help})")


def month_key(d: dt.date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def next_month(d: dt.date) -> dt.date:
    return dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def is_month_end(d: dt.date) -> bool:
    return (d + dt.timedelta(days=1)).month != d.month


def months_for_day(d: dt.date) -> list[str]:
    """Monthly files that can hold trips starting on d. The files are split by END time, so a
    trip that starts on the last day of a month and ends after midnight is in the next month's
    file. Returns ["YYYY-MM", ...] (the first one is required, the second optional)."""
    months = [month_key(d)]
    if is_month_end(d):
        months.append(month_key(next_month(d)))
    return months


def parquet_path(month: str) -> Path:
    return TRIPS / f"{month}.parquet"


# ---------------------------------------------------------------- duckdb
def _physical_ram_bytes() -> int | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def duckdb_settings() -> tuple[str, int]:
    mem = os.environ.get("DUCKDB_MEMORY_LIMIT")
    if not mem:
        ram = _physical_ram_bytes()
        mem = f"{max(1, int(ram * 0.6 / 2**30))}GB" if ram else "4GB"
    threads = int(os.environ.get("DUCKDB_THREADS") or os.cpu_count() or 4)
    return mem, threads


def duckdb_connect(database: str = ":memory:") -> duckdb.DuckDBPyConnection:
    mem, threads = duckdb_settings()
    tmp = DATA / "duckdb_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(database)
    con.execute(f"SET memory_limit='{mem}'; SET threads={threads}; SET temp_directory='{tmp}';")
    return con

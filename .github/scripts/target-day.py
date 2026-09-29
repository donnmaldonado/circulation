#!/usr/bin/env python3
"""Pick the day the daily build shows, and the trip months it touches.

    target-day.py [YYYY-MM-DD]

With no argument (or an empty one) the day is today in New York minus one
year, with 29 February falling back to 28 February. This is the same rule as
pipeline/daily.py's default; the workflow passes the day to daily.py
explicitly so the build and the cache keys can never disagree.

Prints GitHub Actions outputs (key=value lines):
  date    the day, YYYY-MM-DD
  months  the months of the day before, the day and the day after, joined by
          "_" (e.g. 2025-09_2025-10). Citi Bike's monthly files are split by
          end time, so a day near a month boundary can need two files. Used
          as the trip-parquet cache key and to prune the cache.
"""

import re
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


def default_day(today: date) -> date:
    if (today.month, today.day) == (2, 29):
        return date(today.year - 1, 2, 28)
    return today.replace(year=today.year - 1)


def main() -> int:
    arg = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if arg:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arg):
            print(f"::error::date input {arg!r} is not YYYY-MM-DD", file=sys.stderr)
            return 1
        try:
            day = date.fromisoformat(arg)
        except ValueError:
            print(f"::error::date input {arg!r} is not a real day", file=sys.stderr)
            return 1
    else:
        day = default_day(datetime.now(ZoneInfo("America/New_York")).date())

    months = sorted({(day + timedelta(days=d)).strftime("%Y-%m") for d in (-1, 0, 1)})
    print(f"date={day.isoformat()}")
    print(f"months={'_'.join(months)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

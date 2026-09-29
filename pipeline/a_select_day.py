"""Workstream A, step 2: clean one day's trips and write the day's outputs.

Usage:  cd pipeline && uv run python a_select_day.py [--date YYYY-MM-DD]
        (default: today in New York minus one year)
Needs:  data/trips/YYYY-MM.parquet for D's month (from a_ingest.py), plus the next month's file
        if D is the last day of its month and that file exists. Monthly files are split by END
        time, so the next month's file holds the trips that start on D and end after midnight.

The day's trips are those whose `started_at` falls on D (NYC local time, as given in the CSVs).

Cleaning (each dropped trip is attributed to the first rule it fails, in this order):
  short        duration < 60 s (includes negative durations)
  long         duration > 3 h
  null_station start or end station id is null
  round_trip   start station id == end station id
Coordinates are snapped to each station's median lat/lng over D's calendar month (start and end
appearances pooled, trips that start in the month); station name is the most common name seen.

Outputs (pipeline/out/): day.parquet, stations.parquet, pairs.parquet, day.json
"""

import argparse
import json

from common import OUT, add_date_arg, default_date, duckdb_connect, months_for_day, parquet_path

MIN_S, MAX_S = 60, 3 * 3600
WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_date_arg(ap)
    day = ap.parse_args().date or default_date()
    months = months_for_day(day)
    if not parquet_path(months[0]).exists():
        raise SystemExit(f"missing {parquet_path(months[0])}; run a_ingest.py --date {day} first")
    source_months = [m for m in months if parquet_path(m).exists()]
    files = [str(parquet_path(m)) for m in source_months]
    month_start = day.replace(day=1)

    OUT.mkdir(exist_ok=True)
    con = duckdb_connect()
    con.execute(f"CREATE VIEW all_trips AS SELECT * FROM read_parquet({files!r})")
    raw_trips = con.execute(
        f"SELECT count(*) FROM all_trips WHERE CAST(started_at AS DATE) = DATE '{day}'"
    ).fetchone()[0]
    if raw_trips == 0:
        raise SystemExit(f"no trips start on {day} in {source_months}")
    dow = (day.isoweekday() % 7)  # 0 = Sunday, as duckdb's dayofweek
    print(f"Day: {day} ({WEEKDAYS[dow]}), raw trips = {raw_trips:,}, from {source_months}")

    # --- station medians over the chosen day's calendar month --------------------------------
    con.execute(
        f"""
        CREATE TABLE month_obs AS
        SELECT start_station_id AS id, start_station_name AS name, start_lat AS lat, start_lng AS lng
        FROM all_trips
        WHERE started_at >= DATE '{month_start}' AND started_at < DATE '{month_start}' + INTERVAL 1 MONTH
          AND start_station_id IS NOT NULL
        UNION ALL
        SELECT end_station_id, end_station_name, end_lat, end_lng
        FROM all_trips
        WHERE started_at >= DATE '{month_start}' AND started_at < DATE '{month_start}' + INTERVAL 1 MONTH
          AND end_station_id IS NOT NULL
        """
    )
    con.execute(
        """
        CREATE TABLE month_stations AS
        SELECT id,
               mode(name) AS name,
               median(lng) AS lng,
               median(lat) AS lat,
               count(*) AS month_trip_count   -- trip endpoints (departures + arrivals) in the month
        FROM month_obs GROUP BY id
        """
    )

    # --- clean the chosen day's trips -----------------------------------------------------
    con.execute(
        f"""
        CREATE TABLE day_raw AS
        SELECT *,
               CASE
                 WHEN date_diff('millisecond', started_at, ended_at) < {MIN_S * 1000} THEN 'short'
                 WHEN date_diff('millisecond', started_at, ended_at) > {MAX_S * 1000} THEN 'long'
                 WHEN start_station_id IS NULL OR end_station_id IS NULL THEN 'null_station'
                 WHEN start_station_id = end_station_id THEN 'round_trip'
               END AS drop_reason
        FROM all_trips
        WHERE CAST(started_at AS DATE) = DATE '{day}'
        """
    )
    assert con.execute("SELECT count(*) FROM day_raw").fetchone()[0] == raw_trips
    dropped = dict(
        con.execute(
            "SELECT drop_reason, count(*) FROM day_raw WHERE drop_reason IS NOT NULL GROUP BY 1"
        ).fetchall()
    )
    dropped = {k: dropped.get(k, 0) for k in ("short", "long", "null_station", "round_trip")}

    con.execute(
        """
        CREATE TABLE day_clean AS
        SELECT t.ride_id, t.rideable_type, t.member_casual, t.started_at, t.ended_at,
               t.start_station_id, t.end_station_id,
               s.lng AS start_lng, s.lat AS start_lat, e.lng AS end_lng, e.lat AS end_lat,
               t.rideable_type = 'electric_bike' AS is_ebike,
               t.member_casual = 'member' AS is_member
        FROM day_raw t
        JOIN month_stations s ON s.id = t.start_station_id
        JOIN month_stations e ON e.id = t.end_station_id
        WHERE t.drop_reason IS NULL
        ORDER BY t.started_at, t.ride_id
        """
    )
    clean_trips = con.execute("SELECT count(*) FROM day_clean").fetchone()[0]
    # Every station id seen on the day also appears in its month, so the joins must not drop rows.
    assert clean_trips == raw_trips - sum(dropped.values()), "station join lost rows"
    assert con.execute(
        "SELECT count(*) FROM day_clean WHERE start_lng IS NULL OR start_lat IS NULL "
        "OR end_lng IS NULL OR end_lat IS NULL"
    ).fetchone()[0] == 0, "null snapped coords"

    con.execute(
        """
        CREATE TABLE day_stations AS
        SELECT id, name, lng, lat, month_trip_count FROM month_stations
        WHERE id IN (SELECT start_station_id FROM day_clean UNION SELECT end_station_id FROM day_clean)
        ORDER BY id
        """
    )
    con.execute(
        """
        CREATE TABLE day_pairs AS
        SELECT start_station_id, end_station_id,
               any_value(start_lng) AS start_lng, any_value(start_lat) AS start_lat,
               any_value(end_lng) AS end_lng, any_value(end_lat) AS end_lat,
               count(*) AS n
        FROM day_clean GROUP BY start_station_id, end_station_id
        ORDER BY n DESC, start_station_id, end_station_id
        """
    )

    for table, name in [("day_clean", "day"), ("day_stations", "stations"), ("day_pairs", "pairs")]:
        con.execute(f"COPY {table} TO '{OUT / name}.parquet' (FORMAT parquet, COMPRESSION zstd)")

    unique_pairs = con.execute("SELECT count(*) FROM day_pairs").fetchone()[0]
    n_stations = con.execute("SELECT count(*) FROM day_stations").fetchone()[0]
    summary = {
        "date": str(day),
        "weekday": WEEKDAYS[dow],
        "raw_trips": raw_trips,
        "raw_trips_note": "trips with started_at on this date (NYC local), before cleaning",
        "clean_trips": clean_trips,
        "dropped": dropped,
        "dropped_note": "each trip counted once, under the first rule it fails in the order listed",
        "source_months": source_months,
        "source_months_note": "Citi Bike monthly files read (split by end time); the next month is "
        "included only when the day is the last of its month",
        "station_coords_month": str(month_start)[:7],
        "unique_pairs": unique_pairs,
        "stations": n_stations,
    }
    (OUT / "day.json").write_text(json.dumps(summary, indent=2) + "\n")

    print(f"Clean trips: {clean_trips:,} (dropped {raw_trips - clean_trips:,}: {dropped})")
    print(f"Unique directed pairs: {unique_pairs:,}; stations: {n_stations:,}")


if __name__ == "__main__":
    main()

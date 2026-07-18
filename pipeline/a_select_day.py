"""Workstream A, step 2: pick the day, clean its trips, and write the day's outputs.

Usage:  cd pipeline && uv run python a_select_day.py
Needs:  data/trips/2026-06..08.parquet (from a_ingest.py)

Day rule: the Tue/Wed/Thu in Jun-Aug 2026 with the most raw trips, counted by the calendar
date of `started_at` (NYC local time, as given in the CSVs), before any cleaning.
Monthly files are split by end time, so all three months are unioned before counting.
August 2026 is the newest month published; September's file would complete Aug 31, a Monday.

Cleaning (each dropped trip is attributed to the first rule it fails, in this order):
  short        duration < 60 s (includes negative durations)
  long         duration > 3 h
  null_station start or end station id is null
  round_trip   start station id == end station id
Coordinates are snapped to each station's median lat/lng over the chosen day's calendar month
(start and end appearances pooled); station name is the most common name seen for that id.

Outputs (pipeline/out/): day.parquet, stations.parquet, pairs.parquet, day.json,
daily_counts_2026_summer.csv
"""

import json
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
TRIPS_GLOB = str(HERE / "data" / "trips" / "2026-0[6-8].parquet")
OUT = HERE / "out"
MONTHS = ["2026-06", "2026-07", "2026-08"]
MIN_S, MAX_S = 60, 3 * 3600
WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    con = duckdb.connect()
    con.execute("SET memory_limit='6GB'; SET threads=6;")
    con.execute(f"CREATE VIEW all_trips AS SELECT * FROM read_parquet('{TRIPS_GLOB}')")

    # --- daily raw counts, Jun 1 - Aug 31 by started_at date -------------------------------
    con.execute(
        """
        CREATE TABLE daily AS
        SELECT CAST(started_at AS DATE) AS date, dayofweek(started_at) AS dow, count(*) AS trips
        FROM all_trips
        WHERE started_at >= DATE '2026-06-01' AND started_at < DATE '2026-09-01'
        GROUP BY ALL ORDER BY date
        """
    )
    daily = con.execute("SELECT date, dow, trips FROM daily ORDER BY date").fetchall()
    with open(OUT / "daily_counts_2026_summer.csv", "w") as f:
        f.write("date,weekday,trips\n")
        for d, dow, n in daily:
            f.write(f"{d},{WEEKDAYS[dow]},{n}\n")

    top5 = con.execute(
        "SELECT date, dow, trips FROM daily WHERE dow IN (2,3,4) ORDER BY trips DESC, date LIMIT 5"
    ).fetchall()
    day, dow, raw_trips = top5[0]
    month_start = day.replace(day=1)
    print(f"Chosen day: {day} ({WEEKDAYS[dow]}), raw trips = {raw_trips:,}")
    for d, w, n in top5:
        print(f"  candidate {d} {WEEKDAYS[w]:<9} {n:,}")

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
        "raw_trips_note": "trips with started_at on this date (NYC local), before cleaning; "
        "day chosen by this raw count",
        "clean_trips": clean_trips,
        "dropped": dropped,
        "dropped_note": "each trip counted once, under the first rule it fails in the order listed",
        "candidate_top5": [{"date": str(d), "weekday": WEEKDAYS[w], "trips": n} for d, w, n in top5],
        "months_used": MONTHS,
        "station_coords_month": str(month_start)[:7],
        "unique_pairs": unique_pairs,
        "stations": n_stations,
    }
    (OUT / "day.json").write_text(json.dumps(summary, indent=2) + "\n")

    print(f"Clean trips: {clean_trips:,} (dropped {raw_trips - clean_trips:,}: {dropped})")
    print(f"Unique directed pairs: {unique_pairs:,}; stations: {n_stations:,}")


if __name__ == "__main__":
    main()

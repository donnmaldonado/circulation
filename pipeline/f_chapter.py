"""Workstream F: did congestion pricing change Citi Bike trips into the zone?

Congestion pricing started 2025-01-05. The zone is Manhattan south of and
including 60th St (see f_zone.py). We count cleaned trips that END at a station
inside the zone and those that end outside it. The windows are weekdays from
2025-01-06 to 2025-03-31 ("after") and the same weekdays shifted back 364 days,
2024-01-08 to 2024-04-01 ("before"). A day pair is dropped if either day is a
federal holiday (MLK Day, Presidents' Day). The measure is a simple
difference-in-differences (DiD):
  headline  did_pct_points = zone % change - outside % change
  also      did_ratio      = (zone after/before) / (outside after/before)
A rough 95% interval comes from the spread of the per-day-pair log DiD.

Inputs:  pipeline/data/f/trips_YYYYMM.parquet (from f_ingest.py), boroughs
         GeoJSON (f_zone.py), Open-Meteo daily weather for Central Park
         (cached in pipeline/data/f/weather.json).
Outputs: web/public/data/chapter.json, pipeline/out/chapter.md,
         pipeline/out/zone_check.png, pipeline/out/zone.geojson

chapter.json schema (per-day values are means over the weekdays kept):
{
  "title": str, "headline": str, "method": str,
  "zone_name": "Manhattan at and below 60th St (Congestion Relief Zone)",
  "windows": {"after": [start, end], "before": [start, end]},   # ISO dates
  "excluded_days": {"after": [...], "before": [...], "reason": str},
  "weekdays": {"after": int, "before": int},                  # days kept
  "zone":    {"before_per_day": num, "after_per_day": num, "pct_change": num},
  "outside": {"before_per_day": num, "after_per_day": num, "pct_change": num},
  "did_pct_points": num,            # headline: zone % change - outside % change
  "did_ratio": num,                 # zone growth factor / outside growth factor
  "did_ratio_ci95": [lo, hi],       # from day-pair log ratios, rough
  "zone_share": {"before": pct, "after": pct},   # % of all trips ending in zone
  "entering_zone": {...same fields as "zone"...}, # start outside, end inside
  "same_stations": {"stations": int, "did_pct_points": num, "did_ratio": num},
  "context": {"ebike_share": {"before": pct, "after": pct},
              "stations": {"zone": [before, after], "outside": [before, after]},
              "weather": {"before": {...}, "after": {...}} | null},
  "series_note": str,
  "series": [{"week_after", "week_before", "days", "zone_after", "zone_before",
              "outside_after", "outside_before"}, ...],
      # WEEKLY (daily was ~8 KB and noisy): mean trips per kept weekday in each
      # week, weeks keyed by their Monday; 2025-03-31 is folded into the last week
  "caveats": [str, ...],
  "source": "pipeline/f_chapter.py"
}

Run: cd pipeline && uv run python f_ingest.py && uv run python f_chapter.py
"""

from __future__ import annotations

import json
import math
import statistics
import subprocess
from datetime import date, timedelta
from pathlib import Path

import duckdb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from shapely import contains_xy  # noqa: E402
from shapely.prepared import prep  # noqa: E402

from f_zone import zone_polygon  # noqa: E402

HERE = Path(__file__).parent
DATA = HERE / "data" / "f"
OUT = HERE / "out"
WEB = HERE.parent / "web" / "public" / "data"
MONTHS = ["202401", "202402", "202403", "202404", "202501", "202502", "202503"]

AFTER = (date(2025, 1, 6), date(2025, 3, 31))
SHIFT = timedelta(days=364)
BEFORE = (AFTER[0] - SHIFT, AFTER[1] - SHIFT)
HOLIDAYS = {date(2024, 1, 15), date(2024, 2, 19), date(2025, 1, 20), date(2025, 2, 17)}  # MLK, Presidents'


def day_pairs() -> tuple[list[tuple[date, date]], list[tuple[date, date]]]:
    kept, dropped = [], []
    d = AFTER[0]
    while d <= AFTER[1]:
        if d.weekday() < 5:
            pair = (d, d - SHIFT)
            (dropped if (pair[0] in HOLIDAYS or pair[1] in HOLIDAYS) else kept).append(pair)
        d += timedelta(days=1)
    return kept, dropped


def pct(a: float, b: float) -> float:
    return round(100 * (a / b - 1), 1)


def weather(kept: list[tuple[date, date]]) -> dict | None:
    path = DATA / "weather.json"
    if not path.exists():
        url = ("https://archive-api.open-meteo.com/v1/archive?latitude=40.7789&longitude=-73.9692"
               f"&start_date={BEFORE[0]}&end_date={AFTER[1]}"
               "&daily=temperature_2m_mean,precipitation_sum,snowfall_sum"
               "&timezone=America%2FNew_York&temperature_unit=fahrenheit&precipitation_unit=inch")
        try:
            r = subprocess.run(["curl", "-sSfL", "-m", "60", url], check=True, capture_output=True)
            path.write_text(r.stdout.decode())
        except subprocess.CalledProcessError:
            return None
    d = json.loads(path.read_text())["daily"]
    w = {t: (tm, p, s) for t, tm, p, s in zip(d["time"], d["temperature_2m_mean"],
                                              d["precipitation_sum"], d["snowfall_sum"])}

    def summ(days: list[date]) -> dict:
        rows = [w[str(x)] for x in days]
        return {"mean_temp_f": round(statistics.mean(r[0] for r in rows), 1),
                "wet_days": sum(r[1] >= 0.1 for r in rows),
                "snow_days": sum(r[2] >= 0.1 for r in rows)}

    return {"source": "Open-Meteo ERA5 archive, Central Park, weekdays kept",
            "before": summ([b for _, b in kept]), "after": summ([a for a, _ in kept])}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    kept, dropped = day_pairs()
    con = duckdb.connect()
    con.execute("SET memory_limit='6GB'; SET threads=6")
    files = [str(DATA / f"trips_{m}.parquet") for m in MONTHS]
    # Cleaning rules; "month" is the source file, used for the station medians.
    con.execute(f"""
        CREATE TEMP TABLE t AS
        SELECT regexp_extract(filename, 'trips_(\\d{{6}})', 1) AS month,
               started_at::DATE AS d, start_station_id AS s, end_station_id AS e,
               start_lat, start_lng, end_lat, end_lng,
               rideable_type = 'electric_bike' AS ebike
        FROM read_parquet({files}, filename=true)
        WHERE start_station_id IS NOT NULL AND end_station_id IS NOT NULL
          AND start_station_id <> end_station_id
          AND started_at IS NOT NULL AND ended_at IS NOT NULL
          AND epoch(ended_at) - epoch(started_at) BETWEEN 60 AND 10800
    """)
    raw = con.execute(f"SELECT count(*) FROM read_parquet({files})").fetchone()[0]
    clean = con.execute("SELECT count(*) FROM t").fetchone()[0]
    print(f"trips: {raw:,} raw -> {clean:,} after cleaning")

    # Median station coordinates per month (starts and ends pooled).
    st = con.execute("""
        SELECT month, id, median(lat) AS lat, median(lng) AS lng, count(*) AS n FROM (
          SELECT month, s AS id, start_lat AS lat, start_lng AS lng FROM t
          UNION ALL SELECT month, e, end_lat, end_lng FROM t)
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        GROUP BY ALL
    """).df()
    zone = zone_polygon()
    st["in_zone"] = contains_xy(zone, st["lng"].to_numpy(), st["lat"].to_numpy())
    con.register("st_df", st)
    con.execute("CREATE TEMP TABLE st AS SELECT month, id, in_zone FROM st_df")

    # Zone check plot (latest month's station positions).
    last = st[st["month"] == "202503"]
    fig, ax = plt.subplots(figsize=(9, 11), dpi=110)
    xs, ys = zone.exterior.xy
    ax.plot(xs, ys, color="#444", lw=0.8)
    for flag, col, lab in [(True, "#e4572e", "in zone"), (False, "#2e86ab", "outside")]:
        sub = last[last["in_zone"] == flag]
        ax.scatter(sub["lng"], sub["lat"], s=4, c=col, label=f"{lab} ({len(sub)})")
    ax.set_xlim(-74.03, -73.90)
    ax.set_ylim(40.68, 40.80)
    ax.set_aspect(1 / math.cos(math.radians(40.75)))
    ax.legend(loc="upper left")
    ax.set_title("Citi Bike stations vs Congestion Relief Zone (Mar 2025 medians)")
    fig.savefig(OUT / "zone_check.png", bbox_inches="tight")
    plt.close(fig)

    # Daily counts by where the trip ends (and whether it entered from outside).
    daily = con.execute("""
        SELECT t.d,
               count(*) FILTER (WHERE ze.in_zone) AS zone,
               count(*) FILTER (WHERE NOT ze.in_zone) AS outside,
               count(*) FILTER (WHERE ze.in_zone AND NOT zs.in_zone) AS entering,
               count(*) FILTER (WHERE t.ebike) AS ebike,
               count(*) AS total
        FROM t JOIN st ze ON ze.month = t.month AND ze.id = t.e
               JOIN st zs ON zs.month = t.month AND zs.id = t.s
        GROUP BY t.d
    """).df()
    daily["d"] = pd.to_datetime(daily["d"]).dt.date
    daily = daily.set_index("d")
    unmatched = clean - int(daily["total"].sum())
    print(f"trips dropped for missing station coordinates: {unmatched:,}")

    A = [a for a, _ in kept]
    B = [b for _, b in kept]

    def block(col: str) -> dict:
        b = daily.loc[B, col].mean()
        a = daily.loc[A, col].mean()
        return {"before_per_day": round(b), "after_per_day": round(a), "pct_change": pct(a, b)}

    z, o, ent = block("zone"), block("outside"), block("entering")
    gz = daily.loc[A, "zone"].mean() / daily.loc[B, "zone"].mean()
    go = daily.loc[A, "outside"].mean() / daily.loc[B, "outside"].mean()
    did_pp = round(z["pct_change"] - o["pct_change"], 1)
    did_ratio = round(gz / go, 3)
    # Rough interval: per-pair log DiD, mean +/- 1.96 se.
    logs = [math.log(daily.at[a, "zone"] / daily.at[b, "zone"])
            - math.log(daily.at[a, "outside"] / daily.at[b, "outside"]) for a, b in kept]
    se = statistics.stdev(logs) / math.sqrt(len(logs))
    mu = statistics.mean(logs)
    ci = [round(math.exp(mu - 1.96 * se), 3), round(math.exp(mu + 1.96 * se), 3)]

    share_b = 100 * daily.loc[B, "zone"].sum() / daily.loc[B, ["zone", "outside"]].sum().sum()
    share_a = 100 * daily.loc[A, "zone"].sum() / daily.loc[A, ["zone", "outside"]].sum().sum()
    ebike_b = 100 * daily.loc[B, "ebike"].sum() / daily.loc[B, "total"].sum()
    ebike_a = 100 * daily.loc[A, "ebike"].sum() / daily.loc[A, "total"].sum()

    # Station counts (distinct end stations used on kept days) and a same-station check.
    con.register("days_b", pd.DataFrame({"d": B}))
    con.register("days_a", pd.DataFrame({"d": A}))
    sc = con.execute("""
        WITH ends AS (
          SELECT CASE WHEN t.d IN (SELECT d FROM days_a) THEN 'after' ELSE 'before' END AS w,
                 t.e AS id, bool_or(ze.in_zone) AS in_zone, count(*) AS n
          FROM t JOIN st ze ON ze.month = t.month AND ze.id = t.e
          WHERE t.d IN (SELECT d FROM days_a) OR t.d IN (SELECT d FROM days_b)
          GROUP BY ALL)
        SELECT * FROM ends
    """).df()
    stations = {k: [int(((sc.w == "before") & (sc.in_zone == f)).sum()),
                    int(((sc.w == "after") & (sc.in_zone == f)).sum())]
                for k, f in [("zone", True), ("outside", False)]}
    both = set(sc.loc[sc.w == "before", "id"]) & set(sc.loc[sc.w == "after", "id"])
    ss = sc[sc.id.isin(both)].groupby(["w", "in_zone"])["n"].sum()
    ss_gz = ss[("after", True)] / ss[("before", True)]
    ss_go = ss[("after", False)] / ss[("before", False)]
    same = {"stations": len(both),
            "zone_pct_change": pct(ss_gz, 1), "outside_pct_change": pct(ss_go, 1),
            "did_pct_points": round(pct(ss_gz, 1) - pct(ss_go, 1), 1),
            "did_ratio": round(ss_gz / ss_go, 3)}

    wx = weather(kept)

    def moved(x: float) -> str:
        return f"rose {x:.1f}%" if x >= 0 else f"fell {-x:.1f}%"

    if ci[0] > 1:
        rel, verdict = "more than", "a zone boost that fits, but does not prove, a pricing effect"
    elif ci[1] < 1:
        rel, verdict = ("slightly less than" if did_pp > -3 else "less than"), "no sign of a congestion-pricing boost"
    else:
        rel, verdict = "about the same as", "no clear congestion-pricing effect"
    other = f"the {o['pct_change']:.1f}% rise" if o["pct_change"] >= 0 else f"the {-o['pct_change']:.1f}% drop"
    headline = (f"Weekday Citi Bike trips ending in the congestion zone {moved(z['pct_change'])} after pricing "
                f"began, {rel} {other} elsewhere ({did_pp:+.1f} points): {verdict}.")

    caveats = [
        "Weather: " + (f"the 2025 window was {wx['after']['mean_temp_f']}°F vs {wx['before']['mean_temp_f']}°F "
                       f"with {wx['after']['wet_days']} vs {wx['before']['wet_days']} wet days"
                       if wx else "not measured")
        + "; DiD removes citywide weather, not effects that differ by area.",
        f"Network: end stations {stations['zone'][0]}→{stations['zone'][1]} in zone, "
        f"{stations['outside'][0]}→{stations['outside'][1]} outside; counting only stations open in both "
        f"windows gives {same['did_pct_points']:+.1f} pts. Fleet size isn't public.",
        f"E-bike share rose {ebike_b:.0f}%→{ebike_a:.0f}%.",
        "MLK and Presidents' Day pairs excluded. Other trends aren't controlled, so this is not causal.",
    ]

    # Weekly series for the chart: per-weekday means over kept days, weeks keyed by
    # their Monday; the lone final Monday (31 Mar) is folded into the last full week.
    nweeks = (AFTER[1] - AFTER[0]).days // 7
    weeks: dict[int, list[tuple[date, date]]] = {}
    for a, b in kept:
        weeks.setdefault(min((a - AFTER[0]).days // 7, nweeks - 1), []).append((a, b))
    series = []
    for w, prs in sorted(weeks.items()):
        wa = [a for a, _ in prs]
        wb = [b for _, b in prs]
        series.append({"week_after": str(AFTER[0] + timedelta(weeks=w)),
                       "week_before": str(BEFORE[0] + timedelta(weeks=w)), "days": len(prs),
                       "zone_after": round(daily.loc[wa, "zone"].mean()),
                       "zone_before": round(daily.loc[wb, "zone"].mean()),
                       "outside_after": round(daily.loc[wa, "outside"].mean()),
                       "outside_before": round(daily.loc[wb, "outside"].mean())})

    chapter = {
        "title": "Did congestion pricing push more riders onto bikes into the zone?",
        "headline": headline,
        "method": ("Cleaned Citi Bike trips, grouped by whether the end station sits in the zone. "
                   "Weekdays 6 Jan-31 Mar 2025 vs the same weekdays 364 days earlier. The headline "
                   "is a difference-in-differences: zone % change minus outside % change."),
        "zone_name": "Manhattan at and below 60th St (Congestion Relief Zone)",
        "windows": {"after": [str(AFTER[0]), str(AFTER[1])], "before": [str(BEFORE[0]), str(BEFORE[1])]},
        "excluded_days": {"after": sorted({str(a) for a, _ in dropped}),
                          "before": sorted({str(b) for _, b in dropped}),
                          "reason": "day pairs touching a federal holiday (MLK Day, Presidents' Day)"},
        "weekdays": {"after": len(A), "before": len(B)},
        "zone": z,
        "outside": o,
        "did_pct_points": did_pp,
        "did_ratio": did_ratio,
        "did_ratio_ci95": ci,
        "zone_share": {"before": round(share_b, 1), "after": round(share_a, 1)},
        "entering_zone": ent,
        "same_stations": same,
        "context": {"ebike_share": {"before": round(ebike_b, 1), "after": round(ebike_a, 1)},
                    "stations": stations, "weather": wx},
        "series_note": "weekly means of trips per kept weekday; last week includes 2025-03-31",
        "series": series,
        "caveats": caveats,
        "source": "pipeline/f_chapter.py",
    }
    (WEB / "chapter.json").write_text(json.dumps(chapter, ensure_ascii=False, separators=(",", ":")))

    md = f"""# Congestion pricing and Citi Bike

**{headline}**

**Method.** Cleaned trips, split by end station inside/outside the zone (Manhattan at and below 60th St). {len(A)} weekdays, 6 Jan–31 Mar 2025, vs the same weekdays 364 days earlier. Headline: zone % change minus outside % change.

| trips/weekday | 2024 | 2025 | change |
|---|---|---|---|
| Ending in zone | {z['before_per_day']:,} | {z['after_per_day']:,} | {z['pct_change']:+.1f}% |
| Ending outside | {o['before_per_day']:,} | {o['after_per_day']:,} | {o['pct_change']:+.1f}% |
| …started outside zone | {ent['before_per_day']:,} | {ent['after_per_day']:,} | {ent['pct_change']:+.1f}% |

DiD: **{did_pp:+.1f} pts**; growth ratio {did_ratio} (95% range {ci[0]}–{ci[1]}, from day pairs).

**Caveats**
""" + "\n".join(f"- {c}" for c in caveats) + "\n"
    (OUT / "chapter.md").write_text(md)
    print(md)
    print(json.dumps({k: chapter[k] for k in ["zone", "outside", "did_pct_points", "did_ratio", "did_ratio_ci95",
                                               "zone_share", "entering_zone", "same_stations", "context"]}, indent=1))


if __name__ == "__main__":
    main()

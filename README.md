# Circulation

Every Citi Bike trip in New York from this day one year ago, replayed on a map. Pick a place or a station and see where its riders go, or where they come from.

**[donnmaldonado.github.io/circulation](https://donnmaldonado.github.io/circulation/)**

![Circulation at 07:30, showing rides leaving Central Park](docs/screenshot.jpg)

[15-second capture](docs/circulation-15s.webm) · [phone view](docs/mobile.jpg)

## Reading the map

- Each trail is one trip. **Cyan** is an e-bike, **ember** is a classic bike. Casual riders are dimmer than members.
- Stations glow **rose** while they fill up with bikes and **violet** while they empty.
- The page opens on rides **leaving Central Park**. Use the filter bar (top left) to pick all of NYC, another place, or the last station you clicked, and to switch between **Leaving** and **Arriving**. **Details** shows rides by hour and the busiest docks at the other end.
- Drag the timeline to scrub. Space plays/pauses, ←/→ jumps 15 minutes, 1/2/3 sets the speed, Esc closes panels.
- The URL follows the filter, so any view can be shared.

Routes are estimates. Citi Bike publishes start and end stations and times, not GPS traces, so each trail is the OSRM cycling route between its two stations, with the trip's real duration spread along it.

## How it works

A GitHub Action rebuilds the site every night for today's date one year back (29 February shows 28 February). Citi Bike publishes a month of trips after the month ends, so the day a year back is always available.

| Step | Script | Output |
|---|---|---|
| Download that month's trips | `a_ingest.py` | `data/trips/YYYY-MM.parquet` |
| Pick the day, clean it, snap stations | `a_select_day.py` | `out/day.json`, `day.parquet`, `pairs.parquet` |
| Build the bike routing graph | `b_osrm.sh` | OSRM server on `:5055` |
| Route every station pair (cached) | `b_route_pairs.py` | `out/routes.parquet` |
| Simplify, time and pack trips for the browser | `c_encode.py` | `web/public/data/` |
| Check the encoding round-trips | `test_encoding.py` | |

`daily.py` runs all of these in order. All paths are relative to `pipeline/`.

**Cleaning** drops trips under 60 s or over 3 h, trips missing a station, and round trips. `day.json` records how many each rule removed. Trips are counted by start time; because Citi Bike splits its monthly files by *end* time, the last day of a month also reads the next month's file.

**Routing** uses OSRM's bicycle profile on OpenStreetMap, clipped to the five boroughs. Routes are cached in `out/routes_cache.duckdb`, so each new day only routes the pairs that haven't been seen before.

**Headline**: `c_encode.py` finds the neighbourhood with the most lopsided hour of arrivals against departures, e.g. *"From 7:30 to 8:30pm, Bed-Stuy absorbs 1.6× more bikes than it sends out."* The candidates behind it are in `out/headline.json`.

**Places** are hand-picked sets of docks, defined in `web/src/stations/places.ts`.

## Running it locally

You need Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 20+, and Docker plus osmium-tool for routing.

```bash
cd pipeline
./b_osrm.sh                                  # one-time: download NY, build the OSRM graph, serve it
uv run python daily.py                       # today one year ago
uv run python daily.py --date 2025-12-25     # or any published day

cd ../web
npm install
npm run dev                                  # http://localhost:5173
```

Without pipeline output, the dev server falls back to synthetic data (`uv run python make_fixture.py` regenerates it). Generated data isn't committed.

Other scripts in `web/`:

| Command | What it does |
|---|---|
| `npm run build` | Static site in `web/dist` |
| `npm run poster` | Regenerate the first-frame poster image |
| `npm run verify -- --preview` | Load timings, fps and console errors against the built site |
| `node scripts/fps-day.mjs` | Frame rate across a simulated day |
| `node scripts/shots.mjs --preview [--mobile]` | Screenshots for review |
| `node scripts/record.mjs` | Re-record `docs/circulation-15s.webm` |

### URL parameters

| Parameter | Effect |
|---|---|
| `?place=<id>` | Open on a place, e.g. `penn-station`. `all` for no filter. Default `central-park`. |
| `?station=<id>` | Open on a station, by Citi Bike station id |
| `?dir=in\|out` | Rides arriving or leaving. Default `out`. |
| `?t=HH:MM`, `?speed=`, `?paused` | Start time and playback |
| `?debug` | FPS meter |
| `?density=full\|half`, `?halo=0`, `?nocull` | Rendering switches, for comparison |
| `?data=fixture` | Synthetic data (dev only) |

## Nightly deploy

`.github/workflows/daily.yml` runs at 05:17 UTC, just after midnight in New York all year.

1. **build** restores its caches (OSRM graph, route cache, trip data), runs the pipeline for the target day, renders the poster in headless Chromium, and builds the site. If the poster fails, the site ships without one rather than show the wrong day.
2. **deploy** publishes `web/dist` to GitHub Pages. If anything fails, nothing is deployed and yesterday's site stays up.
3. **record** commits `history/YYYY-MM-DD.json`, a log of what was shown. The commit also stops GitHub from pausing the schedule after 60 days of inactivity.

A warm run takes about 10 minutes; a cold one 20–30. To rebuild a specific day, use **Run workflow** in the Actions tab with a `date`. Pushes to `main` that touch `web/`, `pipeline/` or the workflow also redeploy.

Between midnight and the nightly deploy, the page is a day behind and says **One year ago yesterday** instead of **One year ago today**.

**Setting up a fork**: make `main` the default branch (scheduled runs only fire there), keep the repo public for free Pages, and set Settings → Pages → Source to **GitHub Actions**.

## Data format

Trips are split into one file per hour, `trips-HH.bin`, holding the trips that start in that hour. Each is little-endian and aligned, so the browser reads it straight into typed arrays:

```
u32 tripCount · u32 vertexCount · u32[tripCount+1] startIndices
u16[vertexCount×2] lng,lat   quantized to manifest.bbox (under 0.4 m)
u16[vertexCount]   seconds since HH:00
u8[tripCount]      flags: bit0 e-bike, bit1 member
```

Routes are simplified to 5 m, which leaves about 12 points per trip. A busy day comes to roughly 15 MB across all 24 files. If a day would exceed 25 MB, `c_encode.py` coarsens the simplification and then thins out casual riders, and records what it did in `manifest.encoded`.

`stations.json` holds each station's net arrivals in 15-minute bins, which drives the station glow.

## Performance

On an M1 MacBook: the poster frame paints in about 0.1 s, the map is playing by about 1.5 s, and the full day runs at 60 fps. Two things make that work:

- `CulledTripsLayer` drops trail segments outside the visible time window in the vertex shader. The stock `TripsLayer` managed 35 fps on the stress fixture.
- `index.html` inlines the poster and preloads the manifest and the two hourly files the opening frame needs, alongside the JS bundle.

On phones, half the trails are drawn and the glow pass is skipped. Station counts and colours still use every trip.

## Credits

- Trip data: [Citi Bike System Data](https://citibikenyc.com/system-data) (Lyft / NYC Bike Share), under the Citi Bike Data License Agreement
- Routing: [OSRM](https://project-osrm.org) on © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), Geofabrik New York extract
- Basemap: © [CARTO](https://carto.com/attributions) Dark Matter, © OpenStreetMap contributors
- Neighbourhood names: [NYC Open Data](https://opendata.cityofnewyork.us) 2020 Neighborhood Tabulation Areas
- Built with deck.gl, MapLibre GL, Vite, DuckDB, shapely and Playwright

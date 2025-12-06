"""Congestion Relief Zone polygon for workstream F.

The zone is Manhattan south of and including 60th Street. Built as follows:
  1. Manhattan borough boundary from NYC Open Data "Borough Boundaries (clipped
     to shoreline)" (dataset gthc-hcne). Keep only the polygon part that is
     Manhattan island itself; this drops Roosevelt, Governors, Randalls/Wards,
     Liberty and Ellis islands and Marble Hill, none of which are in the zone.
  2. Cut it with 60th Street. 60th St's end points come from OpenStreetMap
     (ways "West 60th Street" / "East 60th Street", fetched via Overpass on
     2026-09-24): the west end near Riverside Blvd and the east end near York
     Ave. The line runs about 29 degrees off true east-west, the Manhattan grid.
     Because the zone *includes* 60th St, the cut line is moved half a block
     (40 m, about half the 80 m spacing of the street grid) toward 61st St.
     Everything south of the line is in the zone.

Use zone_polygon() for a shapely Polygon in lng/lat. Run this file to write
pipeline/out/zone.geojson.
"""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

from shapely.geometry import MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import unary_union

HERE = Path(__file__).parent
BORO_PATH = HERE / "data" / "f" / "boroughs.geojson"
BORO_URL = "https://data.cityofnewyork.us/api/geospatial/gthc-hcne?method=export&format=GeoJSON"

# 60th Street end points (lat, lng), from OSM geometry.
W60_WEST = (40.7726974, -73.9910498)  # W 60 St just east of Riverside Blvd
E60_EAST = (40.7590801, -73.9586021)  # E 60 St at York Ave / FDR ramp
HALF_BLOCK_M = 40.0
EMPIRE_STATE = Point(-73.9857, 40.7484)  # a point surely on Manhattan island


def _manhattan_island() -> Polygon:
    if not BORO_PATH.exists():
        BORO_PATH.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-sSfL", "-o", str(BORO_PATH), BORO_URL], check=True)
    fc = json.loads(BORO_PATH.read_text())
    feat = next(f for f in fc["features"] if f["properties"]["boroname"] == "Manhattan")
    geom = shape(feat["geometry"])
    parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    island = [p for p in parts if p.contains(EMPIRE_STATE)]
    assert len(island) == 1, "could not find Manhattan island polygon"
    return island[0]


def cut_line() -> tuple[tuple[float, float], tuple[float, float]]:
    """60th St shifted half a block north; returns two (lng, lat) points far
    beyond both shores."""
    lat0 = (W60_WEST[0] + E60_EAST[0]) / 2
    kx = 111_320 * math.cos(math.radians(lat0))  # metres per degree lng
    ky = 110_950  # metres per degree lat
    # direction along the street, in metres
    dx = (E60_EAST[1] - W60_WEST[1]) * kx
    dy = (E60_EAST[0] - W60_WEST[0]) * ky
    n = math.hypot(dx, dy)
    ux, uy = dx / n, dy / n
    # left-hand normal of a west->east vector points north (toward 61st)
    nx, ny = -uy, ux
    ext = 5000.0  # metres beyond each end
    a = (W60_WEST[1] + (nx * HALF_BLOCK_M - ux * ext) / kx, W60_WEST[0] + (ny * HALF_BLOCK_M - uy * ext) / ky)
    b = (E60_EAST[1] + (nx * HALF_BLOCK_M + ux * ext) / kx, E60_EAST[0] + (ny * HALF_BLOCK_M + uy * ext) / ky)
    return a, b


def grid_angle_deg() -> float:
    lat0 = (W60_WEST[0] + E60_EAST[0]) / 2
    dx = (E60_EAST[1] - W60_WEST[1]) * math.cos(math.radians(lat0))
    dy = E60_EAST[0] - W60_WEST[0]
    return math.degrees(math.atan2(-dy, dx))


def zone_polygon() -> Polygon:
    island = _manhattan_island()
    a, b = cut_line()
    # half-plane south of the line: the line plus two far-south corners
    south = Polygon([a, b, (b[0], 40.40), (a[0], 40.40)])
    z = island.intersection(south)
    if isinstance(z, MultiPolygon):  # keep the main body (drop slivers, if any)
        z = max(z.geoms, key=lambda p: p.area)
    return z


def main() -> None:
    z = zone_polygon()
    out = HERE / "out" / "zone.geojson"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"type": "Feature", "properties": {"name": "Congestion Relief Zone"},
                               "geometry": mapping(z.simplify(0.0001))}))
    print(f"grid angle {grid_angle_deg():.1f} deg; zone bounds {z.bounds}; wrote {out}")
    for name, lat, lng in [("Columbus Circle (59/8 Av)", 40.7681, -73.9819),
                           ("W 61 St & Columbus", 40.7706, -73.9830),
                           ("Roosevelt Island tram", 40.7573, -73.9540),
                           ("Governors Island", 40.6895, -74.0168),
                           ("DUMBO", 40.7033, -73.9881),
                           ("Battery Park", 40.7033, -74.0170),
                           ("E 60 St & York Av", 40.7592, -73.9588)]:
        print(f"  {name:28s} in zone: {z.contains(Point(lng, lat))}")


if __name__ == "__main__":
    main()

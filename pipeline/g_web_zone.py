"""Workstream G: copy the congestion-zone outline to the web app, small.

Reads  out/zone.geojson (written by f_zone.py, the polygon f_chapter.py counts against)
Writes ../web/public/data/zone.geojson: simplified to ~5 m (shapely, topology-
preserving) and rounded to 5 decimals (~1 m). Drawn on the map while the
chapter panel is open.

    uv run python g_web_zone.py
"""

import json
from pathlib import Path

from shapely.geometry import mapping, shape

HERE = Path(__file__).parent
SRC = HERE / "out" / "zone.geojson"
DST = HERE.parent / "web" / "public" / "data" / "zone.geojson"
TOL_DEG = 5 / 111_320  # ~5 m


def rounded(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, 5) for v in obj]
        return [rounded(v) for v in obj]
    return obj


def main() -> None:
    feat = json.loads(SRC.read_text())
    geom = shape(feat["geometry"]).simplify(TOL_DEG, preserve_topology=True)
    out = {
        "type": "Feature",
        "properties": {**feat.get("properties", {}), "source": "pipeline/f_zone.py via g_web_zone.py"},
        "geometry": {"type": geom.geom_type, "coordinates": rounded(mapping(geom)["coordinates"])},
    }
    DST.write_text(json.dumps(out, separators=(",", ":")))
    n0 = sum(len(r) for r in [feat["geometry"]["coordinates"][0]])
    n1 = len(out["geometry"]["coordinates"][0])
    print(f"wrote {DST.relative_to(HERE.parent)}: {DST.stat().st_size:,} bytes, outer ring {n0} -> {n1} points")


if __name__ == "__main__":
    main()

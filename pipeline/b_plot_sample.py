"""Workstream B: visual check that routes follow streets.

Picks N random non-fallback routes (fixed seed) and draws each in its own panel over the OSM
highway network for that panel's bbox (extracted from osm/nyc.osm.pbf with the osmium CLI).

Usage: uv run python b_plot_sample.py [--routes R] [--out PNG] [--n 5] [--seed 7]
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import polyline  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402

HERE = Path(__file__).resolve().parent
PBF = HERE / "osm" / "nyc.osm.pbf"

# line widths per highway class (bigger roads drawn heavier)
WIDTH = {"motorway": 1.6, "trunk": 1.4, "primary": 1.2, "secondary": 1.0, "tertiary": 0.9,
         "residential": 0.7, "cycleway": 0.8, "unclassified": 0.6, "living_street": 0.6}
SKIP = {"footway", "steps", "corridor", "elevator", "proposed", "construction", "platform", "bus_stop"}


def street_lines(bbox: tuple[float, float, float, float], tmp: Path) -> tuple[list, list, list]:
    """Return (segments, widths, colors) for highway ways in bbox (lng/lat)."""
    w, s, e, n = bbox
    clip = tmp / "clip.osm.pbf"
    hw = tmp / "hw.osm.pbf"
    gj = tmp / "hw.geojsonseq"
    subprocess.run(["osmium", "extract", "-b", f"{w},{s},{e},{n}", "--overwrite", "-o", clip, PBF],
                   check=True, capture_output=True)
    subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", hw, clip, "w/highway"],
                   check=True, capture_output=True)
    subprocess.run(["osmium", "export", "-f", "geojsonseq", "--geometry-types=linestring",
                    "--overwrite", "-o", gj, hw], check=True, capture_output=True)
    segs, widths, colors = [], [], []
    for line in gj.read_text().splitlines():
        line = line.lstrip("\x1e")
        if not line:
            continue
        f = json.loads(line)
        kind = f["properties"].get("highway", "")
        if kind in SKIP:
            continue
        segs.append(f["geometry"]["coordinates"])
        widths.append(WIDTH.get(kind.removesuffix("_link"), 0.5))
        colors.append("#7fb77e" if kind == "cycleway" else "#b8b8b8")
    return segs, widths, colors


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", type=Path, default=HERE / "out" / "routes.parquet")
    ap.add_argument("--out", type=Path, default=HERE / "out" / "route_samples.png")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    routes = pd.read_parquet(args.routes)
    sample = routes[~routes["fallback"]].sample(args.n, random_state=args.seed)

    fig, axes = plt.subplots(1, args.n, figsize=(5.2 * args.n, 6.2), dpi=130)
    axes = [axes] if args.n == 1 else list(axes)
    with tempfile.TemporaryDirectory() as td:
        for ax, r in zip(axes, sample.itertuples()):
            pts = polyline.decode(r.polyline, 6)
            lats = [p[0] for p in pts]
            lngs = [p[1] for p in pts]
            # square-ish bbox around the route with margin
            kx = math.cos(math.radians(sum(lats) / len(lats)))
            cx, cy = (min(lngs) + max(lngs)) / 2, (min(lats) + max(lats)) / 2
            half = max((max(lngs) - min(lngs)) * kx, max(lats) - min(lats)) / 2 * 1.15 + 0.002
            bbox = (cx - half / kx, cy - half, cx + half / kx, cy + half)
            segs, widths, colors = street_lines(bbox, Path(td))
            ax.add_collection(LineCollection(segs, linewidths=widths, colors=colors, zorder=1))
            ax.plot([lngs[0], lngs[-1]], [lats[0], lats[-1]], ls=(0, (3, 3)), lw=1, color="#888", zorder=2,
                    label="straight line")
            ax.plot(lngs, lats, color="#d6336c", lw=2.4, alpha=0.9, zorder=3, label="OSRM bike route")
            ax.scatter([lngs[0]], [lats[0]], s=45, color="#1c7ed6", zorder=4, label="start station")
            ax.scatter([lngs[-1]], [lats[-1]], s=45, color="#212529", marker="s", zorder=4, label="end station")
            ax.set_xlim(bbox[0], bbox[2])
            ax.set_ylim(bbox[1], bbox[3])
            ax.set_aspect(1 / kx)
            ax.set_xticks([])
            ax.set_yticks([])
            ax.set_title(f"{r.start_station_id} → {r.end_station_id}\n"
                         f"{r.distance_m / 1000:.2f} km, {r.duration_s / 60:.0f} min", fontsize=10)
    axes[0].legend(loc="lower left", fontsize=8, framealpha=0.9)
    fig.suptitle(f"{args.n} random routes from {args.routes.name} (seed {args.seed}) over OSM highways "
                 "(green = cycleway)", fontsize=12)
    fig.tight_layout()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

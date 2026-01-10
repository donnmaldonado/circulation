#!/usr/bin/env bash
# Workstream B: download + clip NYC OSM, build OSRM (bicycle, MLD), run osrm-routed.
# Idempotent: each step is skipped if its output already exists.
#   ./b_osrm.sh            # full setup + (re)start container
#   ./b_osrm.sh restart    # just (re)start the container on existing build
#   ./b_osrm.sh rebuild    # delete build outputs and rebuild (keeps clipped pbf)
#
# Image: the Docker Hub tag osrm/osrm-backend:latest is a 2021 amd64-only build;
# the same project publishes multi-arch (native arm64) images on GHCR.
# Host port: 5000 is taken by macOS AirPlay Receiver, so we map to 5055.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OSM_DIR="$HERE/osm"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v6.0.0}"
CONTAINER="${OSRM_CONTAINER:-circulation-osrm}"
PORT="${OSRM_PORT:-5055}"
BBOX="-74.27,40.48,-73.68,40.93"   # all five boroughs
STATE_URL="https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf"
STATE_PBF="$OSM_DIR/new-york-latest.osm.pbf"
NYC_PBF="$OSM_DIR/nyc.osm.pbf"
BUILD="$OSM_DIR/build"              # OSRM files live here: build/nyc.osrm*

mkdir -p "$OSM_DIR" "$BUILD"
log() { echo "[b_osrm $(date +%H:%M:%S)] $*"; }

start_container() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "removing existing container $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null
  fi
  log "starting $CONTAINER on localhost:$PORT"
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -p "$PORT:5000" -v "$BUILD:/data" "$IMAGE" \
    osrm-routed --algorithm mld --threads 8 /data/nyc.osrm >/dev/null
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT/route/v1/bike/-73.9857,40.7484;-73.9772,40.7527?overview=false" >/dev/null; then
      log "OSRM is up: http://localhost:$PORT"; return 0
    fi
    sleep 1
  done
  log "OSRM did not come up; logs:"; docker logs --tail 50 "$CONTAINER"; return 1
}

case "${1:-}" in
  restart) start_container; exit 0 ;;
  rebuild) rm -f "$BUILD"/nyc.osrm* ;;
esac

# 1. download + clip
if [[ ! -s "$NYC_PBF" ]]; then
  if [[ ! -s "$STATE_PBF" ]]; then
    log "downloading $STATE_URL"
    curl -fL --retry 3 -o "$STATE_PBF.part" "$STATE_URL"
    mv "$STATE_PBF.part" "$STATE_PBF"
  fi
  log "clipping to bbox $BBOX"
  osmium extract --bbox "$BBOX" --strategy complete_ways --overwrite -o "$NYC_PBF" "$STATE_PBF"
  rm -f "$STATE_PBF"   # save disk; the clipped file is all we need
fi

# 2. build (extract -> partition -> customize)
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
if [[ ! -s "$BUILD/nyc.osrm.mldgr" ]]; then
  cp "$NYC_PBF" "$BUILD/nyc.osm.pbf"
  t0=$(date +%s)
  log "osrm-extract (bicycle)"
  docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-extract -p /opt/bicycle.lua /data/nyc.osm.pbf
  log "osrm-partition"
  docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-partition /data/nyc.osrm
  log "osrm-customize"
  docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-customize /data/nyc.osrm
  rm -f "$BUILD/nyc.osm.pbf"
  log "build done in $(( $(date +%s) - t0 ))s"
fi

# 3. serve
start_container

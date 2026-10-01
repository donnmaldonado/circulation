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
# Runs on macOS (Docker Desktop, osmium from Homebrew) and Linux (e.g. a GitHub ubuntu runner:
# Docker + `apt-get install osmium-tool`). On Linux the containers run as the calling user so
# the build files stay owned by it (cacheable, deletable).
# Env: OSRM_THREADS (default: CPU count), OSRM_PORT (5055), OSRM_IMAGE, OSRM_CONTAINER.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OSM_DIR="$HERE/osm"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v6.0.0}"
CONTAINER="${OSRM_CONTAINER:-circulation-osrm}"
PORT="${OSRM_PORT:-5055}"
BBOX="-74.27,40.48,-73.68,40.93"   # all five boroughs
STATE_DIR_URL="https://download.geofabrik.de/north-america/us"
STATE_URL="$STATE_DIR_URL/new-york-latest.osm.pbf"
STATE_PBF="$OSM_DIR/new-york-latest.osm.pbf"
NYC_PBF="$OSM_DIR/nyc.osm.pbf"
BUILD="$OSM_DIR/build"              # OSRM files live here: build/nyc.osrm*
if [[ -z "${OSRM_THREADS:-}" ]]; then
  OSRM_THREADS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi
DOCKER_USER=()
if [[ "$(uname -s)" == "Linux" ]]; then
  DOCKER_USER=(--user "$(id -u):$(id -g)")
fi

mkdir -p "$OSM_DIR" "$BUILD"
log() { echo "[b_osrm $(date +%H:%M:%S)] $*"; }

# Geofabrik's -latest aliases can vanish (on 2026-10-01 every one of them was gone
# and the URL redirected in a loop), so the fallback is the newest dated extract in
# the directory listing: new-york-YYMMDD.osm.pbf, which sorts by date.
newest_dated_url() {
  local name
  name="$(curl -fsS "$STATE_DIR_URL/" | grep -oE 'new-york-[0-9]{6}\.osm\.pbf' | sort -u | tail -1 || true)"
  [[ -n "$name" ]] && echo "$STATE_DIR_URL/$name"
}

start_container() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "removing existing container $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null
  fi
  log "starting $CONTAINER on localhost:$PORT"
  docker run -d --name "$CONTAINER" --restart unless-stopped ${DOCKER_USER[@]+"${DOCKER_USER[@]}"} \
    -p "$PORT:5000" -v "$BUILD:/data" "$IMAGE" \
    osrm-routed --algorithm mld --threads "$OSRM_THREADS" /data/nyc.osrm >/dev/null
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
    if ! curl -fL --retry 3 --max-redirs 5 -o "$STATE_PBF.part" "$STATE_URL"; then
      url="$(newest_dated_url)" || { log "no dated extract listed at $STATE_DIR_URL/"; exit 1; }
      log "falling back to $url"
      curl -fL --retry 3 -o "$STATE_PBF.part" "$url"
    fi
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
  run=(docker run --rm ${DOCKER_USER[@]+"${DOCKER_USER[@]}"} -v "$BUILD:/data" "$IMAGE")
  log "osrm-extract (bicycle, $OSRM_THREADS threads)"
  "${run[@]}" osrm-extract -t "$OSRM_THREADS" -p /opt/bicycle.lua /data/nyc.osm.pbf
  log "osrm-partition"
  "${run[@]}" osrm-partition -t "$OSRM_THREADS" /data/nyc.osrm
  log "osrm-customize"
  "${run[@]}" osrm-customize -t "$OSRM_THREADS" /data/nyc.osrm
  rm -f "$BUILD/nyc.osm.pbf"
  log "build done in $(( $(date +%s) - t0 ))s"
fi

# 3. serve
start_container

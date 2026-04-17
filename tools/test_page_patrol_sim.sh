#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
PAGE_URL="file://${REPO_ROOT}/src/map_tools/web/index.html"
CHROME_USER_DATA_DIR="${PAGE_TEST_CHROME_PROFILE:-/tmp/ros2_salus_page_test_chrome}"
DEVTOOLS_PORT="${PAGE_TEST_DEVTOOLS_PORT:-9222}"
DRIVE_MS="${PAGE_TEST_DRIVE_MS:-10000}"
PATROL_OBSERVE_MS="${PAGE_TEST_PATROL_OBSERVE_MS:-4000}"
MIN_WAYPOINTS="${PAGE_TEST_MIN_WAYPOINTS:-2}"
SHOW_BROWSER=0
KEEP_RUNNING=0
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: tools/test_page_patrol_sim.sh [options]

Options:
  --show-browser   Open Chrome visibly so you can watch the page test.
  --keep-running   Leave Chrome + simulation running after the test.
  --skip-build     Skip colcon build before launching the simulation.
  --help           Show this message.

Environment:
  ROS2_CONTAINER_NAME          Default: ros2_salus
  PAGE_TEST_DEVTOOLS_PORT      Default: 9222
  PAGE_TEST_DRIVE_MS           Default: 10000
  PAGE_TEST_PATROL_OBSERVE_MS  Default: 4000
  PAGE_TEST_MIN_WAYPOINTS      Default: 2
EOF
}

log() {
  printf '[page-sim-test] %s\n' "$*"
}

for arg in "$@"; do
  case "$arg" in
    --show-browser)
      SHOW_BROWSER=1
      ;;
    --keep-running)
      KEEP_RUNNING=1
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cleanup() {
  local exit_code="$1"
  if [[ "${KEEP_RUNNING}" -eq 1 ]]; then
    log "keeping browser and simulation running"
    return
  fi

  pkill -f "remote-debugging-port=${DEVTOOLS_PORT}.*$(basename "${CHROME_USER_DATA_DIR}")" >/dev/null 2>&1 || true
  "${REPO_ROOT}/tools/stop_sim_global_v2.sh" >/dev/null 2>&1 || true
  docker exec "${CONTAINER}" bash -lc "
    for pattern in \
      '^/usr/bin/python3 /ros2_ws/install/navegacion_gps/lib/navegacion_gps/manual_waypoint_recorder' \
      '^/usr/bin/python3 /opt/ros/humble/bin/ros2 run navegacion_gps manual_waypoint_recorder' \
      '^/usr/bin/python3 /ros2_ws/install/navegacion_gps/lib/navegacion_gps/loop_patrol_runner' \
      '^/usr/bin/python3 /opt/ros/humble/bin/ros2 run navegacion_gps loop_patrol_runner'
    do
      pids=\$(pgrep -f \"\$pattern\" || true)
      if [ -n \"\$pids\" ]; then
        kill \$pids || true
      fi
    done
  " >/dev/null 2>&1 || true

  if [[ "${exit_code}" -eq 0 ]]; then
    log "cleanup complete"
  else
    log "cleanup complete after failure"
  fi
}

trap 'cleanup "$?"' EXIT

if ! command -v docker >/dev/null 2>&1; then
  printf 'docker not found\n' >&2
  exit 1
fi
if ! command -v google-chrome >/dev/null 2>&1; then
  printf 'google-chrome not found\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'node not found\n' >&2
  exit 1
fi

if [[ "${SHOW_BROWSER}" -eq 1 && -z "${DISPLAY:-}" ]]; then
  printf 'DISPLAY is not set; use headless mode or export DISPLAY first\n' >&2
  exit 1
fi

log "checking container ${CONTAINER}"
docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"

if [[ "${SKIP_BUILD}" -ne 1 ]]; then
  log "building navegacion_gps and map_tools inside ${CONTAINER}"
  docker exec "${CONTAINER}" bash -lc \
    "source /opt/ros/humble/setup.bash && cd /ros2_ws && colcon build --packages-select navegacion_gps map_tools --symlink-install"
fi

log "stopping previous sim_global_v2 runtime"
"${REPO_ROOT}/tools/stop_sim_global_v2.sh" >/dev/null 2>&1 || true

log "removing previous recorder/patrol helper nodes"
docker exec "${CONTAINER}" bash -lc "
  for pattern in \
    '^/usr/bin/python3 /ros2_ws/install/navegacion_gps/lib/navegacion_gps/manual_waypoint_recorder' \
    '^/usr/bin/python3 /opt/ros/humble/bin/ros2 run navegacion_gps manual_waypoint_recorder' \
    '^/usr/bin/python3 /ros2_ws/install/navegacion_gps/lib/navegacion_gps/loop_patrol_runner' \
    '^/usr/bin/python3 /opt/ros/humble/bin/ros2 run navegacion_gps loop_patrol_runner'
  do
    pids=\$(pgrep -f \"\$pattern\" || true)
    if [ -n \"\$pids\" ]; then
      kill \$pids || true
    fi
  done
"

log "launching sim_global_v2"
docker exec "${CONTAINER}" bash -lc "
  mkdir -p /ros2_ws/logs
  nohup bash -lc 'export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps sim_global_v2.launch.py gps_profile:=f9p_rtk launch_web_app:=True use_keepout:=False' \
    </dev/null >/ros2_ws/logs/sim_global_v2.log 2>&1 &
"

log "starting manual_waypoint_recorder and loop_patrol_runner"
docker exec "${CONTAINER}" bash -lc "
  mkdir -p /ros2_ws/logs
  nohup bash -lc 'source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 run navegacion_gps manual_waypoint_recorder --ros-args -p use_sim_time:=true' \
    </dev/null >/ros2_ws/logs/manual_waypoint_recorder.log 2>&1 &
  nohup bash -lc 'source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 run navegacion_gps loop_patrol_runner --ros-args -p use_sim_time:=true -p nav_mode:=global' \
    </dev/null >/ros2_ws/logs/loop_patrol_runner.log 2>&1 &
"

log "waiting for websocket server"
for _ in $(seq 1 40); do
  if docker exec "${CONTAINER}" bash -lc "grep -q 'WebSocket server listening on ws://0.0.0.0:8766' /ros2_ws/logs/sim_global_v2.log"; then
    break
  fi
  sleep 1
done
docker exec "${CONTAINER}" bash -lc "grep -q 'WebSocket server listening on ws://0.0.0.0:8766' /ros2_ws/logs/sim_global_v2.log"

log "launching Chrome on ${PAGE_URL}"
mkdir -p "${CHROME_USER_DATA_DIR}"
CHROME_ARGS=(
  --no-first-run
  --no-default-browser-check
  --remote-debugging-port="${DEVTOOLS_PORT}"
  --user-data-dir="${CHROME_USER_DATA_DIR}"
)
if [[ "${SHOW_BROWSER}" -ne 1 ]]; then
  CHROME_ARGS+=(--headless=new --disable-gpu)
fi
google-chrome "${CHROME_ARGS[@]}" "${PAGE_URL}" >/tmp/ros2_salus_page_test.chrome.log 2>&1 &

log "waiting for Chrome DevTools"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${DEVTOOLS_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${DEVTOOLS_PORT}/json/version" >/dev/null

log "running page smoke test"
node "${REPO_ROOT}/tools/test_page_patrol_sim.js" \
  --devtools-port="${DEVTOOLS_PORT}" \
  --drive-ms="${DRIVE_MS}" \
  --patrol-observe-ms="${PATROL_OBSERVE_MS}" \
  --min-waypoints="${MIN_WAYPOINTS}"

log "test passed"
if [[ "${KEEP_RUNNING}" -eq 1 ]]; then
  log "page remains open at ${PAGE_URL}"
  log "simulation websocket remains at ws://localhost:8766"
fi

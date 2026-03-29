#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${1:-${ROS2_CONTAINER_NAME:-ros2}}"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "Container '${CONTAINER}' is not running."
  exit 1
fi

docker exec "${CONTAINER}" bash -lc "
  source /ros2_ws/install/setup.bash
  echo '--- scan_3d info ---'
  ros2 topic info /scan_3d || true
  echo '--- scan_3d hz (5s) ---'
  timeout 5 ros2 topic hz /scan_3d || true
  echo '--- scan hz (5s) ---'
  timeout 5 ros2 topic hz /scan || true
  echo '--- tf map->odom (once) ---'
  timeout 5 ros2 topic echo /tf --once || true
  echo '--- tf odom->lidar_link (5s) ---'
  timeout 5 ros2 run tf2_ros tf2_echo odom lidar_link || true
"

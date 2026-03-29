#!/usr/bin/env bash
set -euo pipefail

CONTAINER="ros2"
DISTANCE_M="${1:-2.0}"
TARGET_Y_M="${2:-0.0}"
START_X_M="${3:-0.0}"
START_Y_M="${4:-0.0}"
MID_X_M="$(awk "BEGIN {printf \"%.3f\", ${START_X_M} + (${DISTANCE_M} / 2.0)}")"
END_X_M="$(awk "BEGIN {printf \"%.3f\", ${START_X_M} + ${DISTANCE_M}}")"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "El contenedor ${CONTAINER} no esta corriendo."
  exit 1
fi

docker exec "${CONTAINER}" bash -lc "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 action send_goal /follow_path nav2_msgs/action/FollowPath \"{path: {header: {frame_id: odom}, poses: [{header: {frame_id: odom}, pose: {position: {x: ${START_X_M}, y: ${START_Y_M}, z: 0.0}, orientation: {x: 0.0, y: 0.0, z: 0.0, w: 1.0}}}, {header: {frame_id: odom}, pose: {position: {x: ${MID_X_M}, y: ${START_Y_M}, z: 0.0}, orientation: {x: 0.0, y: 0.0, z: 0.0, w: 1.0}}}, {header: {frame_id: odom}, pose: {position: {x: ${END_X_M}, y: ${TARGET_Y_M}, z: 0.0}, orientation: {x: 0.0, y: 0.0, z: 0.0, w: 1.0}}}]}, controller_id: 'FollowPath', goal_checker_id: 'general_goal_checker'}\" --feedback"

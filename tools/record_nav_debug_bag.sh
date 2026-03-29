#!/usr/bin/env bash
set -euo pipefail

CONTAINER="ros2"
WS="/ros2_ws"
PROFILE="${1:-core}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${WS}/bags/nav_debug_${PROFILE}_${STAMP}"

CORE_TOPICS=(
  /gps/fix
  /odometry/local
  /odometry/gps
  /imu/data
  /scan
  /cmd_vel
  /cmd_vel_safe
  /cmd_vel_final
  /collision_monitor_state
  /nav_command_server/telemetry
  /nav_command_server/events
  /controller/status
  /controller/telemetry
  /diagnostics
  /tf
  /tf_static
  /rosout
)

FULL_NAV2_TOPICS=(
  /plan
  /local_costmap/costmap
  /global_costmap/costmap
  /local_costmap/published_footprint
  /behavior_tree_log
)

TOPICS=("${CORE_TOPICS[@]}")
case "${PROFILE}" in
  core)
    ;;
  full_nav2)
    TOPICS+=("${FULL_NAV2_TOPICS[@]}")
    ;;
  *)
    echo "Perfil invalido: ${PROFILE}" >&2
    echo "Uso: $0 [core|full_nav2]" >&2
    exit 1
    ;;
esac

echo "Grabando rosbag perfil='${PROFILE}' en '${OUT_DIR}'"
echo "Topics:"
printf '  %s\n' "${TOPICS[@]}"

docker exec -it "${CONTAINER}" bash -lc "\
  set -eo pipefail && \
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  if [ -f ${WS}/install/setup.bash ]; then source ${WS}/install/setup.bash; fi && \
  mkdir -p ${WS}/bags && \
  cd ${WS} && \
  ros2 bag record -o ${OUT_DIR} ${TOPICS[*]}"

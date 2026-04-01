#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
WS="/ros2_ws"
LONG_EDGE_M="${BLOCK_LOOP_LONG_EDGE_M:-35.0}"
SHORT_EDGE_M="${BLOCK_LOOP_SHORT_EDGE_M:-18.0}"
TURN_DIRECTION="${BLOCK_LOOP_TURN_DIRECTION:-left}"
OUTPUT_PATH="${BLOCK_LOOP_OUTPUT_PATH:-${WS}/src/navegacion_gps/config/block_loop_benchmark.yaml}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

SEND_GOAL_ARGS=()
if [[ "${BLOCK_LOOP_SEND_GOAL:-0}" == "1" ]]; then
  SEND_GOAL_ARGS+=(--send-goal)
fi

if [[ $# -gt 0 ]]; then
  EXTRA_ARGS=("$@")
else
  EXTRA_ARGS=()
fi

EXTRA_QUOTED=""
SEND_GOAL_QUOTED=""
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  printf -v EXTRA_QUOTED '%q ' "${EXTRA_ARGS[@]}"
fi
if [[ ${#SEND_GOAL_ARGS[@]} -gt 0 ]]; then
  printf -v SEND_GOAL_QUOTED '%q ' "${SEND_GOAL_ARGS[@]}"
fi

echo "Generando loop benchmark tipo cuadra"
echo "long_edge_m=${LONG_EDGE_M} short_edge_m=${SHORT_EDGE_M} turn_direction=${TURN_DIRECTION}"
echo "output=${OUTPUT_PATH}"

docker exec -it "${CONTAINER}" bash -lc "\
  set -eo pipefail && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  if [ -f ${WS}/install/setup.bash ]; then source ${WS}/install/setup.bash; fi && \
  cd ${WS} && \
  ros2 run navegacion_gps loop_waypoint_benchmark \
    --long-edge-m ${LONG_EDGE_M} \
    --short-edge-m ${SHORT_EDGE_M} \
    --turn-direction ${TURN_DIRECTION} \
    --output ${OUTPUT_PATH} \
    ${SEND_GOAL_QUOTED}${EXTRA_QUOTED}"

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Uso: $0 <baseline.json> <candidate.json> [args extra]" >&2
  exit 1
fi

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
WS="/ros2_ws"
BASELINE="$1"
CANDIDATE="$2"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
shift 2
EXTRA_ARGS=("$@")
BASELINE_Q="$(printf '%q' "${BASELINE}")"
CANDIDATE_Q="$(printf '%q' "${CANDIDATE}")"
EXTRA_QUOTED=""

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  printf -v EXTRA_QUOTED '%q ' "${EXTRA_ARGS[@]}"
fi

docker exec -it "${CONTAINER}" bash -lc "\
  set -eo pipefail && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  if [ -f ${WS}/install/setup.bash ]; then source ${WS}/install/setup.bash; fi && \
  cd ${WS} && \
  ros2 run navegacion_gps nav_benchmark_report --baseline ${BASELINE_Q} --candidate ${CANDIDATE_Q} ${EXTRA_QUOTED}"

#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
WS="/ros2_ws"
PROFILE="${1:-heading_core}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${WS}/artifacts/nav_benchmarks"
OUT_FILE="${OUT_DIR}/${PROFILE}_${STAMP}.json"

shift || true
EXTRA_ARGS=("$@")
PROFILE_Q="$(printf '%q' "${PROFILE}")"
EXTRA_QUOTED=""

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  printf -v EXTRA_QUOTED '%q ' "${EXTRA_ARGS[@]}"
fi

echo "Ejecutando benchmark profile='${PROFILE}'"
echo "Salida: ${OUT_FILE}"

docker exec -it "${CONTAINER}" bash -lc "\
  set -eo pipefail && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  if [ -f ${WS}/install/setup.bash ]; then source ${WS}/install/setup.bash; fi && \
  mkdir -p ${OUT_DIR} && \
  cd ${WS} && \
  ros2 run navegacion_gps nav_benchmark_runner --profile ${PROFILE_Q} --output ${OUT_FILE} ${EXTRA_QUOTED}"

echo "Benchmark guardado en ${OUT_FILE}"

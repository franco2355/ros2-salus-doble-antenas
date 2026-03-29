#!/usr/bin/env bash
set -euo pipefail

# Ejecuta un comando dentro del contenedor ya levantado.
# Uso:
#   ./tools/exec.sh                # abre una shell interactiva
#   ./tools/exec.sh <cmd> [args]   # ejecuta el comando dentro del contenedor

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

if [[ $# -eq 0 ]]; then
  docker exec -it "${CONTAINER}" bash -lc "export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE}; exec bash"
  exit 0
fi

docker exec -it "${CONTAINER}" bash -ic "export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE}; $*"

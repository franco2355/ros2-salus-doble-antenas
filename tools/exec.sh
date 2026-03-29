#!/usr/bin/env bash
set -euo pipefail

# Ejecuta un comando dentro del contenedor ya levantado.
# Uso:
#   ./tools/exec.sh                # abre una shell interactiva
#   ./tools/exec.sh <cmd> [args]   # ejecuta el comando dentro del contenedor

CONTAINER="ros2"

if [[ $# -eq 0 ]]; then
  docker exec -it "${CONTAINER}" bash
  exit 0
fi

docker exec -it "${CONTAINER}" bash -ic "$*"

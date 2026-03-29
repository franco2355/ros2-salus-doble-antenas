#!/usr/bin/env bash
set -euo pipefail

# Abre una shell como root dentro del contenedor.
# Uso:
#   ./tools/exec-root.sh

CONTAINER="${ROS2_CONTAINER_NAME:-ros2}"

docker exec -u 0 -it "${CONTAINER}" bash

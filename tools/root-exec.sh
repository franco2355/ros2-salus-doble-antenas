#!/usr/bin/env bash
set -euo pipefail

# Abre una shell como root dentro del contenedor.
# Uso:
#   ./tools/exec-root.sh

CONTAINER="ros2"

docker exec -u 0 -it "${CONTAINER}" bash

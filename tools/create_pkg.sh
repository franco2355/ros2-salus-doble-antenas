#!/usr/bin/env bash
set -euo pipefail

# Crea un paquete ROS2 dentro del contenedor usando ros2 pkg create.
# Uso:
#   ./tools/create_pkg.sh <nombre_paquete> [args...]

CONTAINER="ros2"

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <nombre_paquete> [args...]"
  exit 1
fi

PKG_NAME="$1"
shift

EXTRA_ARGS=("$@")
HAS_BUILD_TYPE=0
HAS_DEPS=0

for arg in "${EXTRA_ARGS[@]}"; do
  if [[ "${arg}" == "--build-type" ]]; then
    HAS_BUILD_TYPE=1
  fi
  if [[ "${arg}" == "--dependencies" ]]; then
    HAS_DEPS=1
  fi
done

DEFAULT_ARGS=()
if [[ ${HAS_BUILD_TYPE} -eq 0 ]]; then
  DEFAULT_ARGS+=("--build-type" "ament_python")
fi
if [[ ${HAS_DEPS} -eq 0 ]]; then
  DEFAULT_ARGS+=("--dependencies" "rclpy")
fi

docker exec -it "${CONTAINER}" bash -lc "cd /ros2_ws/src && ros2 pkg create ${PKG_NAME} ${DEFAULT_ARGS[*]} ${EXTRA_ARGS[*]}"

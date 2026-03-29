#!/usr/bin/env bash
set -euo pipefail

# Compila uno o varios paquetes dentro del contenedor ya levantado.
# Uso:
#   ./tools/compile-ros.sh               # compila todo el workspace
#   ./tools/compile-ros.sh pkg1 pkg2 ... # compila solo esos paquetes

CONTAINER="ros2"
WS="/ros2_ws"

if [[ $# -gt 0 ]]; then
  PKG_LIST=("$@")
  BUILD_CMD="colcon build --packages-select ${PKG_LIST[*]} --symlink-install"
  TARGET_MSG="${PKG_LIST[*]}"
else
  BUILD_CMD="colcon build --symlink-install"
  TARGET_MSG="todo el workspace"
fi

echo "Compilando ${TARGET_MSG} dentro del contenedor '${CONTAINER}'..."

docker exec -it "${CONTAINER}" bash -lc "\
  # Dentro del contenedor evitamos '-u' porque los setup.bash de ROS usan vars no definidas
  set -eo pipefail && \
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  if [ -f ${WS}/install/setup.bash ]; then source ${WS}/install/setup.bash; fi && \
  cd ${WS} && \
  ${BUILD_CMD} && \
  echo 'Build finalizado. Para usar:' && \
  echo '  source ${WS}/install/setup.bash'"

echo "Listo."

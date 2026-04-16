#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
SIM_GLOBAL_GPS_PROFILE="${SIM_GLOBAL_GPS_PROFILE:-}"

./tools/stop_sim_global_v2.sh >/dev/null 2>&1 || true

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "El contenedor ${CONTAINER} no esta corriendo."
  exit 1
fi

GPS_PROFILE_ARG=""
if [[ -n "${SIM_GLOBAL_GPS_PROFILE}" ]]; then
  GPS_PROFILE_ARG=" gps_profile:=${SIM_GLOBAL_GPS_PROFILE}"
fi

docker exec "${CONTAINER}" bash -lc "
  mkdir -p /ros2_ws/logs
  nohup bash -lc 'export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE}; source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps sim_global_v2.launch.py launch_web_app:=True use_keepout:=False${GPS_PROFILE_ARG}' \
    </dev/null >/ros2_ws/logs/sim_global_v2.log 2>&1 &
"

sleep 5

echo "Web app sim_global_v2 disponible en ws://localhost:8766"
echo "Abrir: src/map_tools/web/index.html"
if [[ -n "${SIM_GLOBAL_GPS_PROFILE}" ]]; then
  echo "gps_profile override: ${SIM_GLOBAL_GPS_PROFILE}"
else
  echo "gps_profile: launch default"
fi

./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps rviz_sim_global_v2.launch.py"

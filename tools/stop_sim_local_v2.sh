#!/usr/bin/env bash
set -euo pipefail

CONTAINER="ros2"
PATTERN='ign gazebo|ros_gz_bridge|ros_gz_sim/create|sim_local_v2.launch.py|sim_v2_base.launch.py|sim_sensor_normalizer_v2|vehicle_controller_server|controller_server_node|nav_command_server|ackermann_odometry|ekf_filter_node_local_v2|lifecycle_manager_local_navigation_v2|collision_monitor_lifecycle_manager_local_v2|nav2_local_v2_params.yaml|collision_monitor_v2.yaml|planner_server|controller_server|smoother_server|bt_navigator|behavior_server|waypoint_follower'

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "El contenedor ${CONTAINER} no esta corriendo."
  exit 1
fi

docker exec "${CONTAINER}" bash -lc "
  pids=\$(ps -eo pid=,args= | grep -E \"${PATTERN}\" | grep -v grep | awk '{print \$1}')
  if [ -n \"\${pids}\" ]; then
    kill \${pids} || true
    sleep 2
  fi
  remaining=\$(ps -eo pid=,args= | grep -E \"${PATTERN}\" | grep -v grep || true)
  if [ -n \"\${remaining}\" ]; then
    remaining_pids=\$(printf '%s\n' \"\${remaining}\" | awk '{print \$1}')
    kill -9 \${remaining_pids} || true
    sleep 1
    remaining=\$(ps -eo pid=,args= | grep -E \"${PATTERN}\" | grep -v grep || true)
    if [ -n \"\${remaining}\" ]; then
      echo \"Aun quedan procesos:\" >&2
      echo \"\${remaining}\" >&2
      exit 2
    fi
  fi
"

host_pids=$(ps -eo pid=,args= | grep -E "${PATTERN}|gz sim" | grep -v grep | awk '{print $1}' || true)
if [ -n "${host_pids}" ]; then
  kill ${host_pids} || true
  sleep 2
fi

remaining_host=$(ps -eo pid=,args= | grep -E "${PATTERN}|gz sim" | grep -v grep || true)
if [ -n "${remaining_host}" ]; then
  remaining_host_pids=$(printf '%s\n' "${remaining_host}" | awk '{print $1}')
  kill -9 ${remaining_host_pids} || true
  sleep 1
  remaining_host=$(ps -eo pid=,args= | grep -E "${PATTERN}|gz sim" | grep -v grep || true)
  if [ -n "${remaining_host}" ]; then
    echo "Aun quedan procesos de simulacion en host:" >&2
    echo "${remaining_host}" >&2
    exit 3
  fi
fi

echo "Simulacion v2 detenida."

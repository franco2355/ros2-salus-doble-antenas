#!/usr/bin/env bash
set -euo pipefail

./tools/stop_sim_local_v2.sh >/dev/null 2>&1 || true

./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps sim_local_v2.launch.py"

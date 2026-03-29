#!/usr/bin/env bash
set -euo pipefail

./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; ros2 launch navegacion_gps rviz_real.launch.py custom_urdf:=/ros2_ws/src/navegacion_gps/models/cuatri_real.urdf"

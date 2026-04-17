#!/usr/bin/env bash
set -euo pipefail

# Lanza el stack real con recorder manual + patrol loop en un solo comando.
# Variables opcionales:
#   WAYPOINTS_FILE  (default: /home/ros/.ros/recorded_waypoints.yaml)
#   MIN_DISTANCE_M  (default: 3.0)
#   NAV_MODE        (default: global)
#   LOOP_DELAY_S    (default: 1.0)

CYCLONEDDS_WIFI_URI="file:///ros2_ws/src/navegacion_gps/config/cyclonedds_wifi.xml"
WAYPOINTS_FILE="${WAYPOINTS_FILE:-/home/ros/.ros/recorded_waypoints.yaml}"
MIN_DISTANCE_M="${MIN_DISTANCE_M:-3.0}"
NAV_MODE="${NAV_MODE:-global}"
LOOP_DELAY_S="${LOOP_DELAY_S:-1.0}"

./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; export ROS_DOMAIN_ID=0; export ROS_LOCALHOST_ONLY=0; export CYCLONEDDS_URI=${CYCLONEDDS_WIFI_URI}; ros2 launch navegacion_gps patrol_loop.launch.py waypoints_file:=${WAYPOINTS_FILE} min_distance_m:=${MIN_DISTANCE_M} nav_mode:=${NAV_MODE} loop_delay_s:=${LOOP_DELAY_S}"

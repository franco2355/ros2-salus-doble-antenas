#!/usr/bin/env bash
set -euo pipefail

# Local RViz launcher for the real local-nav v2 stack.
#
# This script is meant to be run on the operator PC, not on the Raspberry Pi.
# The robot is expected to already be running `real_local_v2.launch.py` headless,
# while this helper starts only RViz inside the local Docker workspace so the PC
# can attach to the live ROS 2 graph over DDS.
#
# It does not launch sensors, controllers, or navigation on the robot.
# It only opens the RViz profile for `real_local_v2`.
#
# Cyclone DDS is exported explicitly because that is the middleware used to join
# the robot's ROS 2 graph from the local workstation.
./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; ros2 launch navegacion_gps rviz_real_local_v2.launch.py custom_urdf:=/ros2_ws/src/navegacion_gps/models/cuatri_real.urdf rviz_config:=/ros2_ws/src/navegacion_gps/config/rviz_local_v2.rviz"

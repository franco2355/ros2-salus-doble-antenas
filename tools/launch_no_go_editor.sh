#!/usr/bin/env bash
set -euo pipefail

./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch map_tools no_go_editor.launch.py"

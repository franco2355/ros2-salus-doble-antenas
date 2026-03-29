#!/usr/bin/env bash
set -euo pipefail

WINDOW_SEC="${1:-3.0}"

"$(dirname "$0")/exec.sh" ros2 run navegacion_gps startup_heading_diagnosis -- --window-sec "$WINDOW_SEC"

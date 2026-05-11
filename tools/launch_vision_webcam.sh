#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
VIDEO_DEVICE="${VIDEO_DEVICE:-}"
MODEL_PATH="${MODEL_PATH:-/ros2_ws/src/vision_pipeline/models/yolo11n.onnx}"
CAMERA_PARAMS_FILE="${CAMERA_PARAMS_FILE:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/v4l2_camera_low_latency.yaml}"
DETECTOR_PARAMS_FILE="${DETECTOR_PARAMS_FILE:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/yolo_detector.yaml}"
VISION_TARGET_TOPIC="${VISION_TARGET_TOPIC:-/vision/target}"
VISION_TARGET_TIMEOUT_S="${VISION_TARGET_TIMEOUT_S:-0.35}"
VISION_TARGET_MIN_SCORE="${VISION_TARGET_MIN_SCORE:-0.40}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

if [[ -z "${VIDEO_DEVICE}" ]]; then
  echo "Set VIDEO_DEVICE explicitly. Example: VIDEO_DEVICE=/dev/video1 ./tools/launch_vision_webcam.sh" >&2
  exit 1
fi

docker exec "${CONTAINER}" python3 -c '
import sys
import cv2

device = sys.argv[1]
cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
ok = cap.isOpened()
ret, _frame = cap.read() if ok else (False, None)
if ok:
    cap.release()
if not ok or not ret:
    raise SystemExit(
        f"[vision] selected VIDEO_DEVICE={device} cannot provide frames. "
        "Use a working device such as /dev/video0."
    )
print(f"[vision] verified VIDEO_DEVICE={device}")
' "${VIDEO_DEVICE}"

echo "[vision] cleaning previous vision processes if they are still running..."
docker exec -i "${CONTAINER}" python3 - <<'PYEOF'
import os
import signal
import time

MARKERS = (
    '/vision_pipeline/ip_camera_publisher',
    '/vision_pipeline/yolo_onnx_detector',
    '/vision_pipeline/vision_web_server',
    '/vision_pipeline/vision_target_selector',
    '/v4l2_camera/v4l2_camera_node',
    'ros2 run vision_pipeline yolo_onnx_detector',
    'ros2 run vision_pipeline vision_target_selector',
    'ros2 run v4l2_camera v4l2_camera_node',
)
EXCLUDE = {os.getpid(), os.getppid()}


def matching_processes():
    matches = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in EXCLUDE:
            continue
        try:
            cmdline = (
                open(f'/proc/{pid}/cmdline', 'rb')
                .read()
                .replace(b'\x00', b' ')
                .decode('utf-8', errors='ignore')
                .strip()
            )
        except OSError:
            continue
        if cmdline and any(marker in cmdline for marker in MARKERS):
            matches.append((pid, cmdline))
    return matches


matches = matching_processes()
if matches:
    print('[vision] found previous processes:')
    for pid, cmdline in matches:
        print(f'{pid} {cmdline}')
    for pid, _ in matches:
        try:
            os.kill(pid, signal.SIGINT)
        except ProcessLookupError:
            pass
    time.sleep(1.0)
    for pid, _ in matching_processes():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
PYEOF

docker exec -i "${CONTAINER}" bash -ic "
set -euo pipefail

export RMW_IMPLEMENTATION='${RMW_IMPLEMENTATION_VALUE}'
set +u
source /opt/ros/humble/setup.bash
source /ros2_ws/install/setup.bash
set -u

camera_pid=''
detector_pid=''
echo_pid=''
target_selector_pid=''

cleanup() {
  local exit_code=\$?
  trap - INT TERM HUP EXIT
  for pid in \"\$target_selector_pid\" \"\$echo_pid\" \"\$detector_pid\" \"\$camera_pid\"; do
    if [[ -n \"\$pid\" ]] && kill -0 \"\$pid\" 2>/dev/null; then
      kill -INT \"\$pid\" 2>/dev/null || true
      wait \"\$pid\" 2>/dev/null || true
    fi
  done
  exit \"\$exit_code\"
}

trap cleanup INT TERM HUP EXIT

echo '[vision] starting v4l2_camera...'
ros2 run v4l2_camera v4l2_camera_node \
  --ros-args \
  -r __node:=camera \
  -r __ns:=/camera \
  --params-file '${CAMERA_PARAMS_FILE}' \
  -p video_device:='${VIDEO_DEVICE}' &
camera_pid=\$!

sleep 2

echo '[vision] starting yolo_onnx_detector...'
ros2 run vision_pipeline yolo_onnx_detector \
  --ros-args \
  --params-file '${DETECTOR_PARAMS_FILE}' \
  -p model_path:='${MODEL_PATH}' &
detector_pid=\$!

sleep 3

echo '[vision] nodes:'
ros2 node list || true
echo '[vision] topics:'
ros2 topic list | grep -E '^/camera/image_raw$|^/camera/camera_info$|^/detections$|^/objeto_detectado$' || true
echo '[vision] echoing /objeto_detectado (Ctrl+C corta todo)...'

echo '[vision] starting vision_target_selector...'
ros2 run vision_pipeline vision_target_selector \
  --ros-args \
  -p target_topic:='${VISION_TARGET_TOPIC}' \
  -p detection_timeout_s:=${VISION_TARGET_TIMEOUT_S} \
  -p min_score:=${VISION_TARGET_MIN_SCORE} &
target_selector_pid=\$!

ros2 topic echo /objeto_detectado &
echo_pid=\$!

wait \"\$camera_pid\" \"\$detector_pid\" \"\$echo_pid\" \"\$target_selector_pid\"
"

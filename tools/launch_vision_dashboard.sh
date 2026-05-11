#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
VIDEO_DEVICE="${VIDEO_DEVICE:-}"
MODEL_PATH="${MODEL_PATH:-/ros2_ws/src/vision_pipeline/models/yolo11n.onnx}"
CAMERA_PARAMS_FILE="${CAMERA_PARAMS_FILE:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/v4l2_camera_low_latency.yaml}"
DETECTOR_PARAMS_FILE="${DETECTOR_PARAMS_FILE:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/yolo_detector.yaml}"
HTTP_HOST="${HTTP_HOST:-0.0.0.0}"
HTTP_PORT="${HTTP_PORT:-8088}"
JPEG_QUALITY="${JPEG_QUALITY:-65}"
OVERLAY_ENABLED="${OVERLAY_ENABLED:-false}"
VISION_TARGET_TOPIC="${VISION_TARGET_TOPIC:-/vision/target}"
VISION_TARGET_TIMEOUT_S="${VISION_TARGET_TIMEOUT_S:-0.35}"
VISION_TARGET_MIN_SCORE="${VISION_TARGET_MIN_SCORE:-0.40}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

if [[ -z "${VIDEO_DEVICE}" ]]; then
  echo "[vision] ERROR: VIDEO_DEVICE no está definido." >&2
  echo "[vision] Ejemplo: VIDEO_DEVICE=/dev/video0 ./tools/launch_vision_dashboard.sh" >&2
  echo "[vision] Dispositivos disponibles en este host:" >&2
  ls /dev/video* 2>/dev/null || echo "  (ninguno encontrado)" >&2
  exit 1
fi

# Verificar que el dispositivo existe en el host antes de entrar al container
if [[ ! -e "${VIDEO_DEVICE}" ]]; then
  echo "[vision] ERROR: ${VIDEO_DEVICE} no existe en este host." >&2
  echo "[vision] Dispositivos disponibles:" >&2
  ls /dev/video* 2>/dev/null || echo "  (ninguno encontrado)" >&2
  exit 1
fi

# Verificar que el container está corriendo
if ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true; then
  echo "[vision] ERROR: el container '${CONTAINER}' no está corriendo." >&2
  echo "[vision] Inicialo con: docker compose up -d" >&2
  exit 1
fi

# Verificar que la cámara puede entregar frames (usa OpenCV que negocia el formato automáticamente)
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
        f"[vision] ERROR: {device} no puede proveer frames. "
        "Verificá el número de dispositivo con: ls /dev/video*"
    )
print(f"[vision] verificado {device}")
' "${VIDEO_DEVICE}"

echo "[vision] limpiando instancias previas de vision si quedaron vivas..."
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
    print('[vision] procesos previos encontrados:')
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
web_pid=''
target_selector_pid=''
camera_log=\$(mktemp /tmp/vision_camera_XXXXXX.log)

cleanup() {
  local exit_code=\$?
  trap - INT TERM HUP EXIT
  for pid in \"\$target_selector_pid\" \"\$web_pid\" \"\$detector_pid\" \"\$camera_pid\"; do
    if [[ -n \"\$pid\" ]] && kill -0 \"\$pid\" 2>/dev/null; then
      kill -INT \"\$pid\" 2>/dev/null || true
      wait \"\$pid\" 2>/dev/null || true
    fi
  done
  rm -f \"\$camera_log\"
  exit \"\$exit_code\"
}

trap cleanup INT TERM HUP EXIT

echo '[vision] iniciando v4l2_camera...'
/opt/ros/humble/lib/v4l2_camera/v4l2_camera_node \
  --ros-args \
  -r __node:=camera \
  -r __ns:=/camera \
  --params-file '${CAMERA_PARAMS_FILE}' \
  -p video_device:='${VIDEO_DEVICE}' >\"\$camera_log\" 2>&1 &
camera_pid=\$!

sleep 2

# Verificar que el nodo de cámara sigue vivo después del arranque
if ! kill -0 \"\$camera_pid\" 2>/dev/null; then
  echo '[vision] ERROR: v4l2_camera_node terminó inesperadamente. Log:' >&2
  cat \"\$camera_log\" >&2
  echo '' >&2
  echo '[vision] Posibles causas:' >&2
  echo '  - Formato de pixel incorrecto (cambiá pixel_format en v4l2_camera_low_latency.yaml)' >&2
  echo '  - Resolución no soportada por la cámara' >&2
  echo '  - Dispositivo en uso por otro proceso' >&2
  exit 1
fi
echo '[vision] v4l2_camera corriendo (pid='\$camera_pid')'

echo '[vision] iniciando yolo_onnx_detector...'
/ros2_ws/install/vision_pipeline/lib/vision_pipeline/yolo_onnx_detector \
  --ros-args \
  --params-file '${DETECTOR_PARAMS_FILE}' \
  -p model_path:='${MODEL_PATH}' &
detector_pid=\$!

sleep 2

echo '[vision] iniciando vision_web_server...'
/ros2_ws/install/vision_pipeline/lib/vision_pipeline/vision_web_server \
  --ros-args \
  -p http_host:='${HTTP_HOST}' \
  -p http_port:=${HTTP_PORT} \
  -p jpeg_quality:=${JPEG_QUALITY} \
  -p overlay_enabled:=${OVERLAY_ENABLED} &
web_pid=\$!

echo '[vision] iniciando vision_target_selector...'
/ros2_ws/install/vision_pipeline/lib/vision_pipeline/vision_target_selector \
  --ros-args \
  -p target_topic:='${VISION_TARGET_TOPIC}' \
  -p detection_timeout_s:=${VISION_TARGET_TIMEOUT_S} \
  -p min_score:=${VISION_TARGET_MIN_SCORE} &
target_selector_pid=\$!

sleep 1

HOST_IP=\$(hostname -I 2>/dev/null | awk '{print \$1}')
echo '[vision] dashboard listo:'
echo \"  local:  http://localhost:${HTTP_PORT}\"
if [[ -n \"\$HOST_IP\" ]]; then
  echo \"  red:    http://\${HOST_IP}:${HTTP_PORT}\"
fi
echo '[vision] nodos activos:'
ros2 node list || true
echo '[vision] Ctrl+C para detener cámara, detector y servidor web'

wait \"\$camera_pid\" \"\$detector_pid\" \"\$web_pid\" \"\$target_selector_pid\"
"

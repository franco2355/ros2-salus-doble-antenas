#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -m)" == aarch64 || "$(uname -m)" == armv7l ]]; then
  echo "[vision] ERROR: Este script NO debe ejecutarse en la Raspberry Pi (ARM)." >&2
  echo "[vision] El detector YOLO solo corre en la PC (x86_64)." >&2
  exit 1
fi

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
STREAM_URL="${STREAM_URL:-}"
MODEL_PATH="${MODEL_PATH:-/ros2_ws/src/vision_pipeline/models/yolo11n.onnx}"
DETECTOR_PARAMS_FILE="${DETECTOR_PARAMS_FILE:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/yolo_detector.yaml}"
HTTP_HOST="${HTTP_HOST:-0.0.0.0}"
HTTP_PORT="${HTTP_PORT:-8088}"
TARGET_FPS="${TARGET_FPS:-10.0}"
WIDTH="${WIDTH:-320}"
HEIGHT="${HEIGHT:-180}"
JPEG_QUALITY="${JPEG_QUALITY:-60}"
OVERLAY_ENABLED="${OVERLAY_ENABLED:-false}"
FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS:-rtsp_transport;tcp}"
EXECUTION_PROVIDER="${EXECUTION_PROVIDER:-cuda}"
VISION_DETECTOR_NICE="${VISION_DETECTOR_NICE:-10}"
VISION_TARGET_TOPIC="${VISION_TARGET_TOPIC:-/vision/target}"
VISION_TARGET_TIMEOUT_S="${VISION_TARGET_TIMEOUT_S:-0.35}"
VISION_TARGET_MIN_SCORE="${VISION_TARGET_MIN_SCORE:-0.35}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

if [[ -z "${STREAM_URL}" ]]; then
  echo "[vision] ERROR: STREAM_URL no está definido." >&2
  echo "[vision] Ejemplo RTSP: STREAM_URL='rtsp://admin:PASS@192.168.1.64:554/Streaming/Channels/101' ./tools/launch_vision_dashboard_ipcam.sh" >&2
  echo "[vision] Ejemplo MJPEG: STREAM_URL='http://192.168.1.64/mjpeg' ./tools/launch_vision_dashboard_ipcam.sh" >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true; then
  echo "[vision] ERROR: el container '${CONTAINER}' no está corriendo." >&2
  echo "[vision] Inicialo con: docker compose up -d" >&2
  exit 1
fi

# Pre-check: verificar que el stream RTSP/MJPEG es alcanzable antes de arrancar todo
echo "[vision] verificando stream: ${STREAM_URL} ..."
docker exec -e OPENCV_FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS}" "${CONTAINER}" python3 - "${STREAM_URL}" <<'PYEOF'
import sys, cv2

url = sys.argv[1]

cap = cv2.VideoCapture()
cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000.0)
cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000.0)
cap.open(url, cv2.CAP_FFMPEG)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

ok = cap.isOpened()
ret, _ = cap.read() if ok else (False, None)
cap.release()

if not ok or not ret:
    print(f"[vision] ERROR: no se pudo leer un frame de '{url}'", file=sys.stderr)
    print("[vision] Verificá:", file=sys.stderr)
    print("  - IP y puerto correctos (ej: 192.168.1.64:554)", file=sys.stderr)
    print("  - Credenciales correctas (usuario:password)", file=sys.stderr)
    print("  - Path del canal (ej: /Streaming/Channels/101 o /101)", file=sys.stderr)
    print("  - Que la cámara y el Pi estén en la misma red Ethernet", file=sys.stderr)
    sys.exit(1)

print(f"[vision] stream verificado OK")
PYEOF

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

docker exec -e OPENCV_FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS}" -i "${CONTAINER}" bash -ic "
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
camera_log=\$(mktemp /tmp/vision_ipcam_XXXXXX.log)

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

echo '[vision] iniciando ip_camera_publisher...'
/ros2_ws/install/vision_pipeline/lib/vision_pipeline/ip_camera_publisher \
  --ros-args \
  -p stream_url:='${STREAM_URL}' \
  -p image_topic:=/camera/image_raw \
  -p target_fps:=${TARGET_FPS} \
  -p width:=${WIDTH} \
  -p height:=${HEIGHT} >\"\$camera_log\" 2>&1 &
camera_pid=\$!

sleep 4

if ! kill -0 \"\$camera_pid\" 2>/dev/null; then
  echo '[vision] ERROR: ip_camera_publisher terminó inesperadamente. Log:' >&2
  cat \"\$camera_log\" >&2
  exit 1
fi
echo \"[vision] ip_camera_publisher corriendo (pid=\$camera_pid)\"
# Mostrar primeras líneas del log para confirmar que conectó
grep -i 'connected\|error\|warn' \"\$camera_log\" | head -5 || true

echo '[vision] iniciando yolo_onnx_detector...'
nice -n '${VISION_DETECTOR_NICE}' /ros2_ws/install/vision_pipeline/lib/vision_pipeline/yolo_onnx_detector \
  --ros-args \
  --params-file '${DETECTOR_PARAMS_FILE}' \
  -p model_path:='${MODEL_PATH}' \
  -p conf_threshold:=${VISION_TARGET_MIN_SCORE} \
  -p execution_provider:='${EXECUTION_PROVIDER}' &
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
echo '[vision] Ctrl+C para detener cámara IP, detector y servidor web'

wait \"\$camera_pid\" \"\$detector_pid\" \"\$web_pid\" \"\$target_selector_pid\"
"

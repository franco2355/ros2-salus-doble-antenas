#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
ROOT_DIR="$(cd .. && pwd)"
CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
STREAM_URL="${STREAM_URL:-http://localhost:8089/stream.mjpg}"
CAMERA_RTSP_URL="${CAMERA_RTSP_URL:-rtsp://admin:teamcit2024@192.168.1.64:554/Streaming/Channels/101}"
MODEL_PATH="${MODEL_PATH:-/ros2_ws/src/vision_pipeline/models/yolo11n.onnx}"
DETECTOR_YAML="${DETECTOR_YAML:-/ros2_ws/install/vision_pipeline/share/vision_pipeline/config/yolo_detector.yaml}"
EXECUTION_PROVIDER="${EXECUTION_PROVIDER:-cuda}"

log() { printf '[start-cockpit] %s\n' "$*"; }

# ── RTSP relay local (cámara → localhost:8089) ────────────────────────────────
PIDS_LOCAL=()
cleanup_local() {
  for pid in "${PIDS_LOCAL[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup_local EXIT INT TERM

if lsof -t -i:8089 >/dev/null 2>&1; then
  log "puerto 8089 ya ocupado — reutilizando relay existente"
else
  log "iniciando relay RTSP local en localhost:8089..."
  CAMERA_RTSP_URL="${CAMERA_RTSP_URL}" \
  HTTP_PORT=8089 \
  OUTPUT_FPS=15 \
  JPEG_QUALITY=4 \
  SCALE=640:-2 \
  python3 "${ROOT_DIR}/tools/rtsp_mjpeg_server.py" &
  PIDS_LOCAL+=("$!")
  sleep 4
  if curl -fsS --max-time 3 http://localhost:8089/snap.jpg -o /dev/null 2>&1; then
    log "relay RTSP OK → http://localhost:8089/stream.mjpg"
  else
    log "ADVERTENCIA: relay RTSP aún no responde"
  fi
fi

# ── YOLO pipeline en PC ────────────────────────────────────────────────────────
if [[ "$(uname -m)" == aarch64 || "$(uname -m)" == armv7l ]]; then
  log "ARM detectado — saltando pipeline de visión (solo corre en PC)"
elif ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true; then
  log "ADVERTENCIA: container '${CONTAINER}' no está corriendo — saltando pipeline de visión"
else
  log "limpiando instancias previas del pipeline de visión..."
  docker exec "${CONTAINER}" python3 - <<'PY'
import os, signal, time
MARKERS = ('ip_camera_publisher','yolo_onnx_detector','vision_web_server','vision_target_selector')
EXCLUDE = {os.getpid(), os.getppid()}
def find():
    found = []
    for e in os.listdir('/proc'):
        if not e.isdigit(): continue
        pid = int(e)
        if pid in EXCLUDE: continue
        try:
            cmd = open(f'/proc/{pid}/cmdline','rb').read().replace(b'\x00',b' ').decode(errors='ignore')
        except OSError: continue
        if any(m in cmd for m in MARKERS): found.append(pid)
    return found
for pid in find():
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
time.sleep(1)
for pid in find():
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
PY

  log "iniciando ip_camera_publisher..."
  docker exec -d "${CONTAINER}" bash -c "
    source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash
    ros2 run vision_pipeline ip_camera_publisher --ros-args \
      -p stream_url:='${STREAM_URL}' -p image_topic:=/camera/image_raw \
      -p target_fps:=1.0 -p width:=320 -p height:=180
  "
  sleep 3

  log "iniciando yolo_onnx_detector (${EXECUTION_PROVIDER})..."
  docker exec -d "${CONTAINER}" bash -c "
    source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash
    ros2 run vision_pipeline yolo_onnx_detector --ros-args \
      --params-file '${DETECTOR_YAML}' \
      -p model_path:='${MODEL_PATH}' \
      -p conf_threshold:=0.35 \
      -p execution_provider:='${EXECUTION_PROVIDER}'
  "
  sleep 2

  log "iniciando vision_web_server y vision_target_selector..."
  docker exec -d "${CONTAINER}" bash -c "
    source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash
    ros2 run vision_pipeline vision_web_server --ros-args \
      -p http_host:=0.0.0.0 -p http_port:=8088 -p jpeg_quality:=60 -p overlay_enabled:=false
  "
  docker exec -d "${CONTAINER}" bash -c "
    source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash
    ros2 run vision_pipeline vision_target_selector --ros-args \
      -p target_topic:=/vision/target -p detection_timeout_s:=0.35 -p min_score:=0.35
  "
  sleep 2

  if curl -fsS --max-time 3 http://localhost:8088/data >/dev/null 2>&1; then
    log "pipeline de visión OK → http://localhost:8088/data"
  else
    log "ADVERTENCIA: vision_web_server aún no responde (puede tardar unos segundos más)"
  fi
fi

# ── Liberar puertos si ya están ocupados ──────────────────────────────────────
for PORT in 5173 7681; do
  PIDS=$(lsof -t -i:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    log "liberando puerto $PORT (PID $PIDS)..."
    kill $PIDS 2>/dev/null || true
    sleep 0.3
  fi
done

# ── PTY server + Vite ─────────────────────────────────────────────────────────
log "iniciando PTY server..."
node pty-server.js &
PTY_PID=$!

log "iniciando Vite dev server..."
npm run dev &
VITE_PID=$!

trap 'kill $PTY_PID $VITE_PID "${PIDS_LOCAL[@]}" 2>/dev/null; exit' INT TERM EXIT

wait

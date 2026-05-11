#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COCKPIT_DIR="${ROOT_DIR}/cockpit"

CAMERA_IP="${CAMERA_IP:-192.168.1.64}"
CAMERA_ROUTE_DEV="${CAMERA_ROUTE_DEV:-eno1}"
CAMERA_ROUTE_SRC="${CAMERA_ROUTE_SRC:-192.168.1.30}"
CAMERA_ROUTE_CIDR="${CAMERA_ROUTE_CIDR:-192.168.1.30/24}"
CAMERA_USER="${CAMERA_USER:-admin}"
CAMERA_PASS="${CAMERA_PASS:-teamcit2024}"
CAMERA_SNAPSHOT_URL="${CAMERA_SNAPSHOT_URL:-http://${CAMERA_IP}/ISAPI/Streaming/channels/101/picture}"

RELAY_PORT="${RELAY_PORT:-8089}"
VISION_PORT="${VISION_PORT:-8088}"
COCKPIT_PORT="${COCKPIT_PORT:-5173}"
RELAY_HOST_FOR_CONTAINER="${RELAY_HOST_FOR_CONTAINER:-${CAMERA_ROUTE_SRC}}"
KILL_COCKPIT="${KILL_COCKPIT:-false}"
LAUNCH_COCKPIT="${LAUNCH_COCKPIT:-auto}"

DETECTION_MIN_SCORE="${DETECTION_MIN_SCORE:-0.35}"
VISION_WIDTH="${VISION_WIDTH:-320}"
VISION_HEIGHT="${VISION_HEIGHT:-180}"
VISION_FPS="${VISION_FPS:-10.0}"
YOLO_FPS="${YOLO_FPS:-1.0}"
VISION_PROVIDER="${VISION_PROVIDER:-cpu}"
VISION_NICE="${VISION_NICE:-10}"

PIDS=()

log() {
  printf '[camera-cockpit] %s\n' "$*"
}

cleanup() {
  local code=$?
  trap - INT TERM EXIT
  log "deteniendo procesos..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  exit "$code"
}

kill_previous() {
  log "limpiando instancias previas..."
  KILL_COCKPIT="$KILL_COCKPIT" python3 - <<'PY'
import os
import signal

markers = [
    'launch_camera_cockpit.sh',
    'snapshot_mjpeg_server.py',
    'launch_rtsp_cam.sh',
    'rtsp_mjpeg_server.py',
    'ffmpeg -hide_banner',
    'launch_vision_dashboard_ipcam.sh',
    'ip_camera_publisher',
    'yolo_onnx_detector',
    'vision_web_server',
    'vision_target_selector',
]
if os.environ.get('KILL_COCKPIT', '').lower() == 'true':
    markers.append('vite --host 0.0.0.0 --port 5173')
MARKERS = tuple(markers)
EXCLUDE = {os.getpid(), os.getppid()}
script_pid = os.environ.get('CAMERA_COCKPIT_SCRIPT_PID')
if script_pid and script_pid.isdigit():
    EXCLUDE.add(int(script_pid))

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
        )
    except OSError:
        continue
    if cmdline and any(marker in cmdline for marker in MARKERS):
        try:
            os.kill(pid, signal.SIGTERM)
            print(f'TERM {pid} {cmdline[:120]}')
        except ProcessLookupError:
            pass
PY
  sleep 1
  KILL_COCKPIT="$KILL_COCKPIT" python3 - <<'PY'
import os
import signal

markers = [
    'launch_camera_cockpit.sh',
    'snapshot_mjpeg_server.py',
    'launch_rtsp_cam.sh',
    'rtsp_mjpeg_server.py',
    'ffmpeg -hide_banner',
    'launch_vision_dashboard_ipcam.sh',
    'ip_camera_publisher',
    'yolo_onnx_detector',
    'vision_web_server',
    'vision_target_selector',
]
if os.environ.get('KILL_COCKPIT', '').lower() == 'true':
    markers.append('vite --host 0.0.0.0 --port 5173')
MARKERS = tuple(markers)
EXCLUDE = {os.getpid(), os.getppid()}
script_pid = os.environ.get('CAMERA_COCKPIT_SCRIPT_PID')
if script_pid and script_pid.isdigit():
    EXCLUDE.add(int(script_pid))

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
        )
    except OSError:
        continue
    if cmdline and any(marker in cmdline for marker in MARKERS):
        try:
            os.kill(pid, signal.SIGKILL)
            print(f'KILL {pid} {cmdline[:120]}')
        except ProcessLookupError:
            pass
PY
  local ports=("$RELAY_PORT" "$VISION_PORT")
  if [[ "$KILL_COCKPIT" == "true" ]]; then
    ports+=("$COCKPIT_PORT")
  fi
  for port in "${ports[@]}"; do
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    fi
  done
  sleep 0.5
}

port_responds() {
  local port="$1"
  curl -fsS --max-time 1 "http://localhost:${port}/" >/dev/null 2>&1
}

configure_route() {
  if [[ "${CONFIGURE_CAMERA_ROUTE:-true}" != "true" ]]; then
    return
  fi

  log "configurando ruta a ${CAMERA_IP} por ${CAMERA_ROUTE_DEV}..."
  if ip route get "$CAMERA_IP" 2>/dev/null | grep -q "dev ${CAMERA_ROUTE_DEV} .*src ${CAMERA_ROUTE_SRC}"; then
    log "ruta ya correcta: $(ip route get "$CAMERA_IP" | head -1)"
    return
  fi

  sudo ip addr add "$CAMERA_ROUTE_CIDR" dev "$CAMERA_ROUTE_DEV" 2>/dev/null || true
  sudo ip route replace "${CAMERA_IP}/32" dev "$CAMERA_ROUTE_DEV" src "$CAMERA_ROUTE_SRC"
  log "ruta: $(ip route get "$CAMERA_IP" | head -1)"
}

wait_http() {
  local name="$1"
  local url="$2"
  local tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      log "${name} listo: ${url}"
      return 0
    fi
    sleep 0.5
  done
  log "ERROR: ${name} no respondió: ${url}"
  return 1
}

trap cleanup INT TERM EXIT

cd "$ROOT_DIR"
export CAMERA_COCKPIT_SCRIPT_PID="$$"
kill_previous
configure_route

log "levantando snapshot relay en http://localhost:${RELAY_PORT}/ (JPEG directo, sin H.264)"
CAMERA_SNAPSHOT_URL="$CAMERA_SNAPSHOT_URL" \
CAMERA_USER="$CAMERA_USER" \
CAMERA_PASS="$CAMERA_PASS" \
HTTP_PORT="$RELAY_PORT" \
TARGET_FPS="$VISION_FPS" \
python3 "${ROOT_DIR}/tools/snapshot_mjpeg_server.py" &
PIDS+=("$!")
wait_http "snapshot-relay" "http://localhost:${RELAY_PORT}/snap.jpg" 30

log "levantando vision pipeline en http://localhost:${VISION_PORT}/ (YOLO a ${YOLO_FPS} FPS)"
STREAM_URL="http://${RELAY_HOST_FOR_CONTAINER}:${RELAY_PORT}/stream.mjpg" \
FFMPEG_CAPTURE_OPTIONS="" \
HTTP_PORT="$VISION_PORT" \
OVERLAY_ENABLED=false \
TARGET_FPS="$YOLO_FPS" \
WIDTH="$VISION_WIDTH" \
HEIGHT="$VISION_HEIGHT" \
EXECUTION_PROVIDER="$VISION_PROVIDER" \
VISION_DETECTOR_NICE="$VISION_NICE" \
VISION_TARGET_MIN_SCORE="$DETECTION_MIN_SCORE" \
bash "${ROOT_DIR}/tools/launch_vision_dashboard_ipcam.sh" &
PIDS+=("$!")
wait_http "detecciones" "http://localhost:${VISION_PORT}/data" 80

if [[ "$LAUNCH_COCKPIT" == "false" ]]; then
  log "Cockpit no se levanta (LAUNCH_COCKPIT=false)."
elif [[ "$LAUNCH_COCKPIT" == "auto" ]] && port_responds "$COCKPIT_PORT"; then
  log "Cockpit ya está activo en http://localhost:${COCKPIT_PORT}/; lo reutilizo."
else
  log "levantando Cockpit en http://localhost:${COCKPIT_PORT}/"
  cd "$COCKPIT_DIR"
  npm run dev -- --host 0.0.0.0 --port "$COCKPIT_PORT" &
  PIDS+=("$!")
  wait_http "cockpit" "http://localhost:${COCKPIT_PORT}/" 60
fi

cat <<EOF

Listo:
  Cockpit:     http://localhost:${COCKPIT_PORT}/
  Stream:      http://localhost:${VISION_PORT}/stream.mjpg
  Detecciones: http://localhost:${VISION_PORT}/data
  Snapshot:    http://localhost:${RELAY_PORT}/snap.jpg

Configuracion:
  Fuente:    ${CAMERA_SNAPSHOT_URL}
  Video FPS: ${VISION_FPS}  (8089 → Cockpit)
  YOLO FPS:  ${YOLO_FPS}    (8088 → detecciones)
  Umbral:    ${DETECTION_MIN_SCORE}

Ctrl+C detiene todo lo que levantó este script.

EOF

wait

#!/usr/bin/env bash
# launch_vision_pc_gpu.sh — lanza el pipeline de visión en la PC con GPU.
#
# Corre NATIVAMENTE en la PC (sin Docker).
# La Raspberry Pi solo consume /vision/target y no ejecuta ningún nodo YOLO.
#
# USO:
#   STREAM_URL='rtsp://admin:PASS@192.168.1.64:554/Streaming/Channels/101' \
#   MODEL_PATH='/home/user/models/yolo11n.onnx' \
#   ./tools/launch_vision_pc_gpu.sh
#
# VARIABLES DE ENTORNO:
#   STREAM_URL              (requerido) URL RTSP / MJPEG / HTTP de la cámara IP
#   MODEL_PATH              (requerido) ruta absoluta al modelo YOLO ONNX en la PC
#   EXECUTION_PROVIDER      auto | cuda | tensorrt | openvino | cpu  [default: auto]
#   ROS_DOMAIN_ID           debe coincidir con la Raspberry Pi            [default: 0]
#   RMW_IMPLEMENTATION      debe coincidir con la Raspberry Pi            [default: rmw_cyclonedds_cpp]
#   CYCLONEDDS_URI          ruta a XML de peers CycloneDDS (ver nota red) [default: ""]
#   ROS_INSTALL             directorio de ROS 2 Humble                    [default: /opt/ros/humble]
#   WORKSPACE_INSTALL       directorio install/ del workspace colcon       [default: autodetect]
#   DETECTOR_PARAMS_FILE    YAML de parámetros del detector YOLO          [default: del paquete]
#   TARGET_FPS              FPS objetivo de captura                       [default: 15.0]
#   WIDTH / HEIGHT          resolución de captura                         [default: 640x360]
#   VISION_TARGET_TOPIC     topic de salida del target                    [default: /vision/target]
#   VISION_TARGET_TIMEOUT_S timeout de frescura de detección             [default: 0.35]
#   VISION_TARGET_MIN_SCORE score mínimo para publicar target             [default: 0.70]
#   HTTP_PORT               puerto del dashboard web                      [default: 8088]
#   OVERLAY_ENABLED         overlay de bounding boxes en dashboard        [default: false]
#   INTRA_OP_THREADS        threads intra-op para ONNX Runtime            [default: 4]
#   INTER_OP_THREADS        threads inter-op para ONNX Runtime            [default: 2]
#   FFMPEG_CAPTURE_OPTIONS  opciones ffmpeg para cv2                      [default: rtsp_transport;tcp]
#
# NOTA DE RED (PC <-> Raspberry Pi):
#   Ambas máquinas deben tener:
#     export ROS_DOMAIN_ID=<mismo valor>
#     export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
#   Si están en la misma subnet con multicast habilitado, el descubrimiento es automático.
#   Si hay problemas de red, usá un XML de peers explícito (ver tools/cyclonedds_peers.xml.template).

set -euo pipefail

if [[ "$(uname -m)" == aarch64 || "$(uname -m)" == armv7l ]]; then
  echo "[vision-pc] ERROR: Este script NO debe ejecutarse en la Raspberry Pi (ARM)." >&2
  echo "[vision-pc] El detector YOLO solo corre en la PC (x86_64)." >&2
  exit 1
fi

# ── Variables de configuración ───────────────────────────────────────────────
STREAM_URL="${STREAM_URL:-}"
MODEL_PATH="${MODEL_PATH:-}"
EXECUTION_PROVIDER="${EXECUTION_PROVIDER:-auto}"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}"
export RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
export CYCLONEDDS_URI="${CYCLONEDDS_URI:-}"
ROS_INSTALL="${ROS_INSTALL:-/opt/ros/humble}"
WORKSPACE_INSTALL="${WORKSPACE_INSTALL:-}"
PYTHON_VENV="${PYTHON_VENV:-${HOME}/venvs/ros_vision}"
TARGET_FPS="${TARGET_FPS:-15.0}"
WIDTH="${WIDTH:-640}"
HEIGHT="${HEIGHT:-360}"
VISION_TARGET_TOPIC="${VISION_TARGET_TOPIC:-/vision/target}"
VISION_TARGET_TIMEOUT_S="${VISION_TARGET_TIMEOUT_S:-0.35}"
VISION_TARGET_MIN_SCORE="${VISION_TARGET_MIN_SCORE:-0.70}"
HTTP_HOST="${HTTP_HOST:-0.0.0.0}"
HTTP_PORT="${HTTP_PORT:-8088}"
JPEG_QUALITY="${JPEG_QUALITY:-90}"
OVERLAY_ENABLED="${OVERLAY_ENABLED:-true}"
INTRA_OP_THREADS="${INTRA_OP_THREADS:-4}"
INTER_OP_THREADS="${INTER_OP_THREADS:-2}"
FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS:-rtsp_transport;tcp}"
DETECTOR_PARAMS_FILE="${DETECTOR_PARAMS_FILE:-}"

# ── Validar argumentos requeridos ────────────────────────────────────────────
if [[ -z "${STREAM_URL}" ]]; then
  echo "[vision-pc] ERROR: STREAM_URL no está definido." >&2
  echo "[vision-pc] Ejemplo RTSP:  STREAM_URL='rtsp://admin:PASS@192.168.1.64:554/Streaming/Channels/101'" >&2
  echo "[vision-pc] Ejemplo MJPEG: STREAM_URL='http://192.168.1.64/mjpeg'" >&2
  exit 1
fi

if [[ -z "${MODEL_PATH}" ]]; then
  echo "[vision-pc] ERROR: MODEL_PATH no está definido." >&2
  echo "[vision-pc] Ejemplo: MODEL_PATH='/home/user/models/yolo11n.onnx'" >&2
  exit 1
fi

if [[ ! -f "${MODEL_PATH}" ]]; then
  echo "[vision-pc] ERROR: MODEL_PATH='${MODEL_PATH}' no existe." >&2
  exit 1
fi

# ── Source ROS 2 ─────────────────────────────────────────────────────────────
if [[ ! -f "${ROS_INSTALL}/setup.bash" ]]; then
  echo "[vision-pc] ERROR: ROS 2 no encontrado en '${ROS_INSTALL}'." >&2
  echo "[vision-pc] Instalá ROS 2 Humble o definí: ROS_INSTALL=/opt/ros/humble" >&2
  exit 1
fi

set +u
# Activar venv con onnxruntime-gpu si existe
if [[ -f "${PYTHON_VENV}/bin/activate" ]]; then
  source "${PYTHON_VENV}/bin/activate"
  echo "[vision-pc] venv activo: ${PYTHON_VENV}"
else
  echo "[vision-pc] WARN: venv no encontrado en '${PYTHON_VENV}'. Usando Python del sistema." >&2
  echo "[vision-pc] Para crear el venv: python3 -m venv ${PYTHON_VENV} && source ${PYTHON_VENV}/bin/activate && pip install onnxruntime-gpu opencv-python numpy" >&2
fi

source "${ROS_INSTALL}/setup.bash"

# Autodetectar workspace install/ relativo al repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

if [[ -n "${WORKSPACE_INSTALL}" && -f "${WORKSPACE_INSTALL}/setup.bash" ]]; then
  source "${WORKSPACE_INSTALL}/setup.bash"
elif [[ -f "${REPO_ROOT}/install/setup.bash" ]]; then
  source "${REPO_ROOT}/install/setup.bash"
  WORKSPACE_INSTALL="${REPO_ROOT}/install"
else
  echo "[vision-pc] WARN: no se encontró install/setup.bash en '${REPO_ROOT}'." >&2
  echo "[vision-pc] Si el paquete no está en el PATH, ejecutá primero:" >&2
  echo "[vision-pc]   cd ${REPO_ROOT} && colcon build --packages-select vision_pipeline" >&2
fi
set -u

# Verificar que el paquete vision_pipeline está disponible
if ! ros2 pkg list 2>/dev/null | grep -q '^vision_pipeline$'; then
  echo "[vision-pc] ERROR: paquete 'vision_pipeline' no encontrado en el entorno ROS." >&2
  echo "[vision-pc] Buildá el workspace: cd ${REPO_ROOT} && colcon build --packages-select vision_pipeline interfaces" >&2
  exit 1
fi

# ── Detectar GPU NVIDIA ───────────────────────────────────────────────────────
if [[ "${EXECUTION_PROVIDER}" == "auto" ]]; then
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "NVIDIA GPU")
    echo "[vision-pc] GPU detectada: ${GPU_NAME}"
    echo "[vision-pc] execution_provider=auto → intenta TensorRT → CUDA → CPU"
  else
    echo "[vision-pc] Sin GPU NVIDIA detectada → execution_provider=cpu"
    EXECUTION_PROVIDER="cpu"
  fi
else
  echo "[vision-pc] execution_provider forzado a: ${EXECUTION_PROVIDER}"
fi

# ── Verificar stream de cámara ────────────────────────────────────────────────
echo "[vision-pc] verificando stream: ${STREAM_URL} ..."
OPENCV_FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS}" python3 - "${STREAM_URL}" <<'PYEOF'
import sys
import cv2

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
    print(f"[vision-pc] ERROR: no se pudo leer frame de '{url}'", file=sys.stderr)
    print("[vision-pc] Verificá IP, puerto, credenciales y que la cámara esté en la red.", file=sys.stderr)
    sys.exit(1)
print("[vision-pc] stream verificado OK")
PYEOF

# ── Limpiar instancias previas ────────────────────────────────────────────────
echo "[vision-pc] limpiando instancias previas de visión si quedaron vivas..."
python3 - <<'PYEOF'
import os, signal, time

MARKERS = (
    'ip_camera_publisher',
    'yolo_onnx_detector',
    'vision_web_server',
    'vision_target_selector',
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
        if cmdline and any(m in cmdline for m in MARKERS):
            matches.append((pid, cmdline))
    return matches

matches = matching_processes()
if matches:
    print('[vision-pc] procesos previos encontrados:')
    for pid, cmdline in matches:
        print(f'  {pid}: {cmdline[:80]}')
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

# ── Construir args del detector ───────────────────────────────────────────────
DETECTOR_PARAMS_ARGS=""
if [[ -n "${DETECTOR_PARAMS_FILE}" && -f "${DETECTOR_PARAMS_FILE}" ]]; then
  DETECTOR_PARAMS_ARGS="--params-file ${DETECTOR_PARAMS_FILE}"
fi

# ── PID tracking y cleanup ────────────────────────────────────────────────────
camera_pid=""
detector_pid=""
web_pid=""
target_selector_pid=""
camera_log="$(mktemp /tmp/vision_ipcam_XXXXXX.log)"

cleanup() {
  local exit_code=$?
  trap - INT TERM HUP EXIT
  for pid in "${target_selector_pid}" "${web_pid}" "${detector_pid}" "${camera_pid}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -INT "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  rm -f "${camera_log}"
  exit "${exit_code}"
}

trap cleanup INT TERM HUP EXIT

# ── Lanzar ip_camera_publisher ───────────────────────────────────────────────
echo "[vision-pc] iniciando ip_camera_publisher..."
OPENCV_FFMPEG_CAPTURE_OPTIONS="${FFMPEG_CAPTURE_OPTIONS}" \
ros2 run vision_pipeline ip_camera_publisher \
  --ros-args \
  -p stream_url:="${STREAM_URL}" \
  -p image_topic:=/camera/image_raw \
  -p target_fps:="${TARGET_FPS}" \
  -p width:="${WIDTH}" \
  -p height:="${HEIGHT}" >"${camera_log}" 2>&1 &
camera_pid=$!

sleep 4

if ! kill -0 "${camera_pid}" 2>/dev/null; then
  echo "[vision-pc] ERROR: ip_camera_publisher terminó inesperadamente. Log:" >&2
  cat "${camera_log}" >&2
  exit 1
fi
echo "[vision-pc] ip_camera_publisher corriendo (pid=${camera_pid})"
grep -i 'connected\|error\|warn' "${camera_log}" | head -5 || true

# ── Lanzar yolo_onnx_detector ─────────────────────────────────────────────────
echo "[vision-pc] iniciando yolo_onnx_detector (provider=${EXECUTION_PROVIDER})..."
# shellcheck disable=SC2086
ros2 run vision_pipeline yolo_onnx_detector \
  --ros-args \
  ${DETECTOR_PARAMS_ARGS} \
  -p model_path:="${MODEL_PATH}" \
  -p execution_provider:="${EXECUTION_PROVIDER}" \
  -p intra_op_threads:="${INTRA_OP_THREADS}" \
  -p inter_op_threads:="${INTER_OP_THREADS}" &
detector_pid=$!

sleep 3

if ! kill -0 "${detector_pid}" 2>/dev/null; then
  echo "[vision-pc] ERROR: yolo_onnx_detector terminó inesperadamente." >&2
  echo "[vision-pc] Si pediste CUDA/TensorRT, verificá que onnxruntime-gpu esté instalado:" >&2
  echo "[vision-pc]   pip install onnxruntime-gpu" >&2
  exit 1
fi

# ── Lanzar vision_web_server ──────────────────────────────────────────────────
echo "[vision-pc] iniciando vision_web_server (dashboard http://0.0.0.0:${HTTP_PORT})..."
ros2 run vision_pipeline vision_web_server \
  --ros-args \
  -p http_host:="${HTTP_HOST}" \
  -p http_port:="${HTTP_PORT}" \
  -p jpeg_quality:="${JPEG_QUALITY}" \
  -p overlay_enabled:="${OVERLAY_ENABLED}" &
web_pid=$!

# ── Lanzar vision_target_selector ────────────────────────────────────────────
echo "[vision-pc] iniciando vision_target_selector..."
ros2 run vision_pipeline vision_target_selector \
  --ros-args \
  -p target_topic:="${VISION_TARGET_TOPIC}" \
  -p detection_timeout_s:="${VISION_TARGET_TIMEOUT_S}" \
  -p min_score:="${VISION_TARGET_MIN_SCORE}" &
target_selector_pid=$!

sleep 1

# ── Resumen ───────────────────────────────────────────────────────────────────
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "[vision-pc] ═══════════════════════════════════════════════════"
echo "[vision-pc]  Pipeline de visión activo en PC"
echo "[vision-pc] ═══════════════════════════════════════════════════"
echo "[vision-pc]  ROS_DOMAIN_ID      = ${ROS_DOMAIN_ID}"
echo "[vision-pc]  RMW_IMPLEMENTATION = ${RMW_IMPLEMENTATION}"
echo "[vision-pc]  execution_provider = ${EXECUTION_PROVIDER}"
echo "[vision-pc]  modelo             = ${MODEL_PATH}"
echo "[vision-pc]  stream             = ${STREAM_URL}"
echo "[vision-pc]  salida ROS         = ${VISION_TARGET_TOPIC}"
if [[ -n "${HOST_IP}" ]]; then
  echo "[vision-pc]  dashboard         http://${HOST_IP}:${HTTP_PORT}"
fi
if [[ -n "${CYCLONEDDS_URI}" ]]; then
  echo "[vision-pc]  CYCLONEDDS_URI    = ${CYCLONEDDS_URI}"
fi
echo "[vision-pc] ───────────────────────────────────────────────────"
echo "[vision-pc]  Para verificar que la Raspi recibe /vision/target:"
echo "[vision-pc]    (en la Raspi) ros2 topic echo /vision/target"
echo "[vision-pc] ═══════════════════════════════════════════════════"
echo ""
ros2 node list 2>/dev/null || true
echo "[vision-pc] Ctrl+C para detener todo"

wait "${camera_pid}" "${detector_pid}" "${web_pid}" "${target_selector_pid}"

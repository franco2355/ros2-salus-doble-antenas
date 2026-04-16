#!/usr/bin/env bash
# =============================================================================
# test_goal_cte.sh — Envía un goal a Nav2 y mide cross-track error (oscilación)
#
# Uso:
#   ./tools/test_goal_cte.sh [x_m] [y_m] [yaw_deg] [timeout_s]
#
# Defaults:  x=10  y=0  yaw=0  timeout=60
#
# Exit codes:  0=PASS  1=WARN  2=FAIL
# =============================================================================
set -uo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
RMW="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"

GOAL_X="${1:-10.0}"
GOAL_Y="${2:-0.0}"
GOAL_YAW_DEG="${3:-0.0}"
TIMEOUT_S="${4:-60}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

# ── quaternion via python3 (evita el bug de awk/mawk con sin/cos) ─────────────
read -r GOAL_QZ GOAL_QW < <(python3 -c "
import math, sys
yaw_rad = float('${GOAL_YAW_DEG}') * math.pi / 180.0
print(f'{math.sin(yaw_rad/2.0):.8f} {math.cos(yaw_rad/2.0):.8f}')
" 2>/dev/null) || { GOAL_QZ="0.00000000"; GOAL_QW="1.00000000"; }
GOAL_QZ="${GOAL_QZ:-0.00000000}"
GOAL_QW="${GOAL_QW:-1.00000000}"

TMP_CTE="/tmp/cte_$$"

echo "════════════════════════════════════════════════════════"
echo " test_goal_cte  goal=(${GOAL_X}, ${GOAL_Y}) yaw=${GOAL_YAW_DEG}°  timeout=${TIMEOUT_S}s"
echo "════════════════════════════════════════════════════════"

# ── verificar container ────────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo -e "${RED}ERROR: contenedor '${CONTAINER}' no está corriendo.${NC}"
  echo "       Lanzá la sim primero:  ./tools/launch_sim_global_v2.sh"
  exit 2
fi

# shortcut para ejecutar dentro del container con ROS sourced
_ros() { docker exec "${CONTAINER}" bash -lc \
  "export RMW_IMPLEMENTATION=${RMW}
   source /opt/ros/humble/setup.bash
   source /ros2_ws/install/setup.bash
   $*"; }

# ── reiniciar path_cross_track_monitor para evitar instancias duplicadas ─────
echo "[monitor] Reiniciando path_cross_track_monitor..."
docker exec "${CONTAINER}" bash -lc \
  "pkill -f 'path_cross_track_monitor' || true
   export RMW_IMPLEMENTATION=${RMW}
   source /opt/ros/humble/setup.bash
   source /ros2_ws/install/setup.bash
   setsid bash -lc 'ros2 run navegacion_gps path_cross_track_monitor \
     --ros-args -p warn_threshold_m:=0.40' \
     </dev/null >/tmp/cross_track_monitor.log 2>&1 &
   echo \$!" || true
sleep 3   # esperar a que el nodo se subscribe

# ── recolectar CTE en background (topic echo → archivo temporal en container) ─
# setsid crea una nueva sesión para que el pipeline no reciba SIGHUP cuando
# el docker exec principal termina.
echo "[cte]     Recolectando muestras en ${TMP_CTE}.txt ..."
docker exec "${CONTAINER}" bash -lc \
  "export RMW_IMPLEMENTATION=${RMW}
   source /opt/ros/humble/setup.bash
   source /ros2_ws/install/setup.bash
   rm -f ${TMP_CTE}.txt
   setsid bash -c 'timeout $((TIMEOUT_S + 10)) \
     ros2 topic echo /nav_diagnostics/cross_track_error_m \
       --field data --no-arr 2>/dev/null \
     | grep -oE \"[0-9][0-9.]*\" >> ${TMP_CTE}.txt' </dev/null >/dev/null 2>&1 &
   echo \"collector_pid=\$!  file=${TMP_CTE}.txt\"" || true
sleep 3

# ── enviar goal y esperar resultado ───────────────────────────────────────────
# El YAML va con comillas simples dentro del bash -lc (mismo formato que funciona
# desde la terminal directamente).
echo "[goal]    Enviando NavigateToPose (${GOAL_X}, ${GOAL_Y}) yaw=${GOAL_YAW_DEG}° ..."
echo "[goal]    qz=${GOAL_QZ}  qw=${GOAL_QW}"

ACTION_RAW="$(
  timeout "${TIMEOUT_S}" \
  docker exec "${CONTAINER}" bash -lc "
    export RMW_IMPLEMENTATION=${RMW}
    source /opt/ros/humble/setup.bash
    source /ros2_ws/install/setup.bash
    ros2 action send_goal /navigate_to_pose \
      nav2_msgs/action/NavigateToPose \
      '{pose: {header: {frame_id: map}, pose: {position: {x: ${GOAL_X}, y: ${GOAL_Y}, z: 0.0}, orientation: {x: 0.0, y: 0.0, z: ${GOAL_QZ}, w: ${GOAL_QW}}}}}' \
      --feedback 2>&1
  " 2>&1 || echo "__TIMEOUT__"
)"

# ── determinar resultado de la acción ─────────────────────────────────────────
if echo "${ACTION_RAW}" | grep -qi "succeed"; then
  ACTION_STATUS="SUCCEEDED"
elif echo "${ACTION_RAW}" | grep -q "__TIMEOUT__"; then
  ACTION_STATUS="TIMEOUT"
elif echo "${ACTION_RAW}" | grep -qi "abort\|reject\|cancel"; then
  ACTION_STATUS="ABORTED"
else
  ACTION_STATUS="UNKNOWN"
fi

sleep 1  # último sample CTE

# ── analizar muestras CTE con python3 ─────────────────────────────────────────
echo ""
echo "[stats]   Analizando muestras CTE..."

ANALYSIS="$(
  docker exec -i "${CONTAINER}" python3 - << PYEOF
import math, sys

try:
    with open('${TMP_CTE}.txt') as f:
        lines = [l.strip() for l in f if l.strip()]
except FileNotFoundError:
    print('n=0'); sys.exit(0)

samples = []
for line in lines:
    try:
        samples.append(float(line))
    except ValueError:
        pass

n = len(samples)
if n < 3:
    print(f'n={n}'); sys.exit(0)

max_cte  = max(samples)
mean_cte = sum(samples) / n
std_cte  = math.sqrt(sum((x - mean_cte)**2 for x in samples) / n)
above    = [s > mean_cte for s in samples]
crossings = sum(1 for i in range(1, n) if above[i] != above[i-1])

print(f'n={n}')
print(f'max_cte={max_cte:.4f}')
print(f'mean_cte={mean_cte:.4f}')
print(f'std_cte={std_cte:.4f}')
print(f'crossings={crossings}')
PYEOF
2>/dev/null || echo "n=0"
)"

N_SAMPLES="$(echo "${ANALYSIS}" | grep '^n='         | cut -d= -f2 || echo 0)"
MAX_CTE="$(  echo "${ANALYSIS}" | grep '^max_cte='   | cut -d= -f2 || echo 999)"
MEAN_CTE="$( echo "${ANALYSIS}" | grep '^mean_cte='  | cut -d= -f2 || echo 999)"
STD_CTE="$(  echo "${ANALYSIS}" | grep '^std_cte='   | cut -d= -f2 || echo 999)"
CROSSINGS="$(echo "${ANALYSIS}" | grep '^crossings=' | cut -d= -f2 || echo 999)"

# ── veredicto ─────────────────────────────────────────────────────────────────
MAX_MM="$(python3 -c "print(int(float('${MAX_CTE}') * 1000))" 2>/dev/null || echo 99999)"
CRS="${CROSSINGS:-999}"

if [ "${ACTION_STATUS}" = "SUCCEEDED" ] && \
   [ "${MAX_MM}"         -lt 500 ]        && \
   [ "${CRS}"            -lt 8   ]; then
  VERDICT="${GREEN}PASS${NC}";  EXIT_CODE=0
elif [ "${MAX_MM}" -lt 800 ] && [ "${CRS}" -lt 16 ]; then
  VERDICT="${YELLOW}WARN${NC}"; EXIT_CODE=1
else
  VERDICT="${RED}FAIL${NC}";   EXIT_CODE=2
fi

# ── reporte ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo " RESULTADO"
echo "════════════════════════════════════════════════════════"
printf " Acción Nav2     : %s\n"  "${ACTION_STATUS}"
printf " Muestras CTE    : %s\n"  "${N_SAMPLES}"
printf " max_cte         : %s m\n"  "${MAX_CTE}"
printf " mean_cte        : %s m\n" "${MEAN_CTE}"
printf " std_cte         : %s m\n" "${STD_CTE}"
printf " cruces/cero     : %s  ← indicador de oscilación\n" "${CROSSINGS}"
echo "────────────────────────────────────────────────────────"
echo " PASS   max_cte < 0.50 m  AND  cruces <  8"
echo " WARN   max_cte < 0.80 m  AND  cruces < 16"
echo " FAIL   max_cte >= 0.80 m  OR  cruces >= 16"
echo "────────────────────────────────────────────────────────"
printf " Veredicto: "; echo -e "${VERDICT}"
echo "════════════════════════════════════════════════════════"

# limpiar tmp
_ros "rm -f ${TMP_CTE}.txt" 2>/dev/null || true

exit ${EXIT_CODE}

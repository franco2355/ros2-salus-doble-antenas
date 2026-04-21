#!/bin/bash
# test_esquivar.sh — Prueba manual de la secuencia de evasión de obstáculos.
#
# Levanta: nav_command_server + controller_server + obstacle_recovery
# Luego dispara /fusion/brake_active a 10 Hz para activar la maniobra.
#
# Uso:
#   ./test_esquivar.sh            → lanza nodos y dispara la maniobra
#   ./test_esquivar.sh --solo-trigger → solo dispara (nodos ya corriendo)
#   ./test_esquivar.sh --status   → monitorea /fusion/recovery/status

set -e

WORKSPACE_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_FILE="$WORKSPACE_DIR/install/setup.bash"

# ── colores ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ── source workspace ───────────────────────────────────────────────────────
if [[ ! -f "$SETUP_FILE" ]]; then
    error "No se encontró $SETUP_FILE — compilá el workspace primero (colcon build)"
    exit 1
fi
# shellcheck source=/dev/null
source "$SETUP_FILE"

# ── modo --status ──────────────────────────────────────────────────────────
if [[ "$1" == "--status" ]]; then
    info "Monitoreando /fusion/recovery/status (Ctrl+C para salir)..."
    ros2 topic echo /fusion/recovery/status
    exit 0
fi

# ── modo --solo-trigger ────────────────────────────────────────────────────
trigger_maneuver() {
    info "Publicando brake_active=true a 10 Hz (Ctrl+C para detener)..."
    warn "La maniobra arranca después de 3 frames (~300ms)"
    echo ""
    ros2 topic pub --rate 10 /fusion/brake_active std_msgs/msg/Bool "data: true"
}

if [[ "$1" == "--solo-trigger" ]]; then
    trigger_maneuver
    exit 0
fi

# ── limpieza al salir ──────────────────────────────────────────────────────
PIDS=()
cleanup() {
    echo ""
    info "Cerrando nodos..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait "${PIDS[@]}" 2>/dev/null || true
    ok "Listo."
}
trap cleanup EXIT INT TERM

# ── lanzar nodos ──────────────────────────────────────────────────────────
info "Iniciando nav_command_server..."
ros2 run navegacion_gps nav_command_server \
    --ros-args \
    -p cmd_vel_safe_topic:=/cmd_vel_safe \
    -p cmd_vel_final_topic:=/cmd_vel_final \
    -p teleop_cmd_topic:=/cmd_vel_teleop \
    -p manual_cmd_timeout_s:=0.4 \
    -p manual_watchdog_hz:=10.0 \
    2>&1 | sed 's/^/[nav_cmd_server] /' &
PIDS+=($!)

info "Iniciando controller_server_node..."
ros2 run controller_server controller_server_node \
    --ros-args \
    -p serial_port:=/dev/serial0 \
    -p serial_baud:=115200 \
    -p max_reverse_mps:=1.30 \
    -p vx_deadband_mps:=0.01 \
    -p vx_min_effective_mps:=0.5 \
    2>&1 | sed 's/^/[controller]  /' &
PIDS+=($!)

info "Iniciando obstacle_recovery..."
ros2 run lidar_camara obstacle_recovery \
    --ros-args \
    -p require_consecutive:=3 \
    -p backup_speed_mps:=0.3 \
    -p backup_duration_s:=2.0 \
    -p cooldown_s:=6.0 \
    -p cmd_hz:=10.0 \
    2>&1 | sed 's/^/[recovery]    /' &
PIDS+=($!)

# ── esperar inicialización ─────────────────────────────────────────────────
info "Esperando que los nodos inicien (3s)..."
sleep 3

# ── verificar que están vivos ──────────────────────────────────────────────
all_ok=true
for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
        error "Un nodo falló al iniciar (PID $pid)"
        all_ok=false
    fi
done

if [[ "$all_ok" == false ]]; then
    error "Abortando — revisá los logs de arriba"
    exit 1
fi
ok "Los 3 nodos están corriendo"

# ── monitorear estado en background ───────────────────────────────────────
echo ""
info "Monitoreando /fusion/recovery/status en background..."
ros2 topic echo /fusion/recovery/status 2>&1 | sed 's/^/[status]      /' &
PIDS+=($!)

# ── disparar la maniobra ───────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Presioná ENTER para disparar la maniobra de evasión${NC}"
echo -e "${YELLOW}  (Ctrl+C para salir sin disparar)${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
read -r

trigger_maneuver

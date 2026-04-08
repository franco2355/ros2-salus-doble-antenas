#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
RMW_IMPLEMENTATION_VALUE="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
HOST_WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_WS="/ros2_ws"
PLAY_RATE="${REPLAY_BAG_RATE:-4.0}"
STARTUP_WAIT_S="${REPLAY_STARTUP_WAIT_S:-4}"
RECORD_START_WAIT_S="${REPLAY_RECORD_WAIT_S:-2}"

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <bag_dir_host> [output_dir_host]" >&2
  exit 1
fi

resolve_abs_path() {
  local raw_path="$1"
  if [[ "${raw_path}" = /* ]]; then
    printf '%s\n' "${raw_path}"
  else
    printf '%s/%s\n' "${HOST_WS}" "${raw_path}"
  fi
}

INPUT_BAG_HOST="$(resolve_abs_path "$1")"
if [[ ! -d "${INPUT_BAG_HOST}" ]]; then
  echo "No existe el bag '${INPUT_BAG_HOST}'." >&2
  exit 1
fi
INPUT_METADATA_HOST="${INPUT_BAG_HOST}/metadata.yaml"
if [[ ! -f "${INPUT_METADATA_HOST}" ]]; then
  echo "Falta metadata.yaml en '${INPUT_BAG_HOST}'." >&2
  exit 1
fi

if [[ $# -ge 2 ]]; then
  OUTPUT_ROOT_HOST="$(resolve_abs_path "$2")"
else
  BAG_BASENAME="$(basename "${INPUT_BAG_HOST}")"
  OUTPUT_ROOT_HOST="${HOST_WS}/artifacts/replay_localization/${BAG_BASENAME}"
fi

mkdir -p "${OUTPUT_ROOT_HOST}"

INPUT_BAG_BASENAME="$(basename "${INPUT_BAG_HOST}")"
OUTPUT_ROOT_BASENAME="$(basename "${OUTPUT_ROOT_HOST}")"
INPUT_BAG_CONTAINER="${CONTAINER_WS}/bags/${INPUT_BAG_BASENAME}"
OUTPUT_ROOT_CONTAINER="${CONTAINER_WS}/artifacts/replay_localization/${OUTPUT_ROOT_BASENAME}"
REPLAY_BAG_CONTAINER="${OUTPUT_ROOT_CONTAINER}/replay_outputs"
REPLAY_REPORT_CONTAINER="${OUTPUT_ROOT_CONTAINER}/compare.json"
LAUNCH_LOG_CONTAINER="${OUTPUT_ROOT_CONTAINER}/replay_launch.log"
PLAY_LOG_CONTAINER="${OUTPUT_ROOT_CONTAINER}/bag_play.log"
QOS_OVERRIDES_CONTAINER="${OUTPUT_ROOT_CONTAINER}/bag_play_qos_overrides.yaml"

has_topic() {
  local topic_name="$1"
  rg -q "name: ${topic_name}" "${INPUT_METADATA_HOST}"
}

PLAY_TOPICS=(/controller/drive_telemetry /imu/data)
REPLAY_MODE="global_filter_fallback"
if has_topic "/gps/fix"; then
  PLAY_TOPICS+=(/gps/fix)
  REPLAY_MODE="raw_gps"
else
  if has_topic "/gps/odometry_map"; then
    PLAY_TOPICS+=(/gps/odometry_map)
  fi
  if has_topic "/gps/course_heading"; then
    PLAY_TOPICS+=(/gps/course_heading)
  fi
fi

cleanup() {
  docker exec "${CONTAINER}" bash -lc "\
    pkill -INT -f 'ros2 bag record -o ${REPLAY_BAG_CONTAINER}' >/dev/null 2>&1 || true; \
    pkill -INT -f 'ros2 launch navegacion_gps replay_localization_global_v2.launch.py' >/dev/null 2>&1 || true"
}
trap cleanup EXIT

cleanup

docker exec "${CONTAINER}" bash -lc "\
  rm -rf '${INPUT_BAG_CONTAINER}' '${OUTPUT_ROOT_CONTAINER}' && \
  mkdir -p '${OUTPUT_ROOT_CONTAINER}'"

echo "Copiando bag al contenedor..."
docker cp "${INPUT_BAG_HOST}" "${CONTAINER}:${CONTAINER_WS}/bags/"

docker exec "${CONTAINER}" bash -lc "\
  cat > '${QOS_OVERRIDES_CONTAINER}' <<'YAML'
/imu/data:
  history: keep_last
  depth: 10
  reliability: reliable
  durability: volatile
/gps/fix:
  history: keep_last
  depth: 10
  reliability: reliable
  durability: volatile
YAML"

echo "Modo replay: ${REPLAY_MODE}"
printf 'Topics reproducidos:'
for topic in "${PLAY_TOPICS[@]}"; do
  printf ' %s' "${topic}"
done
printf '\n'

echo "Levantando replay offline de localizacion..."
docker exec -d "${CONTAINER}" bash -lc "\
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  source ${CONTAINER_WS}/install/setup.bash && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  exec ros2 launch navegacion_gps replay_localization_global_v2.launch.py \
    >'${LAUNCH_LOG_CONTAINER}' 2>&1"

sleep "${STARTUP_WAIT_S}"

echo "Grabando salidas recalculadas en '${REPLAY_BAG_CONTAINER}'..."
docker exec -d "${CONTAINER}" bash -lc "\
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  source ${CONTAINER_WS}/install/setup.bash && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  exec ros2 bag record -o '${REPLAY_BAG_CONTAINER}' \
    /odometry/local \
    /odometry/local_global \
    /imu/data_global \
    /odometry/local_yaw_hold \
    /odometry/gps \
    /gps/odometry_map \
    /gps/course_heading \
    /gps/course_heading/debug \
    /odometry/global \
    /tf >/dev/null 2>&1"

sleep "${RECORD_START_WAIT_S}"

echo "Reproduciendo inputs del bag '${INPUT_BAG_CONTAINER}'..."
docker exec "${CONTAINER}" bash -lc "\
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  source ${CONTAINER_WS}/install/setup.bash && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  ros2 bag play '${INPUT_BAG_CONTAINER}' \
    --clock 50.0 \
    --rate ${PLAY_RATE} \
    --qos-profile-overrides-path '${QOS_OVERRIDES_CONTAINER}' \
    --topics ${PLAY_TOPICS[*]} \
    >'${PLAY_LOG_CONTAINER}' 2>&1"

sleep 2
cleanup
sleep 2

echo "Comparando bag original vs replay..."
docker exec "${CONTAINER}" bash -lc "\
  source /opt/ros/\${ROS_DISTRO:-humble}/setup.bash && \
  source ${CONTAINER_WS}/install/setup.bash && \
  export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION_VALUE} && \
  ros2 run navegacion_gps replay_localization_compare \
    --recorded-bag '${INPUT_BAG_CONTAINER}' \
    --replay-bag '${REPLAY_BAG_CONTAINER}' \
    --output '${REPLAY_REPORT_CONTAINER}'"

rm -rf "${OUTPUT_ROOT_HOST}"
mkdir -p "$(dirname "${OUTPUT_ROOT_HOST}")"
docker cp "${CONTAINER}:${OUTPUT_ROOT_CONTAINER}" "$(dirname "${OUTPUT_ROOT_HOST}")/"

echo
echo "Replay listo."
echo "Salidas:"
echo "  report: ${OUTPUT_ROOT_HOST}/compare.json"
echo "  replay bag: ${OUTPUT_ROOT_HOST}/replay_outputs"
echo "  launch log: ${OUTPUT_ROOT_HOST}/replay_launch.log"
echo "  play log: ${OUTPUT_ROOT_HOST}/bag_play.log"

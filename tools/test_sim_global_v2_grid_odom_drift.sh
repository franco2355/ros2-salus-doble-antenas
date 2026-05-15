#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

CONTAINER="${ROS2_CONTAINER_NAME:-ros2_salus}"
MAX_GRID_ODOM_DRIFT_M="${MAX_GRID_ODOM_DRIFT_M:-1.0}"
MAX_GRID_ODOM_YAW_DEG="${MAX_GRID_ODOM_YAW_DEG:-5.0}"
GRID_ODOM_WAIT_TIMEOUT_S="${GRID_ODOM_WAIT_TIMEOUT_S:-45}"
GRID_ODOM_WARMUP_S="${GRID_ODOM_WARMUP_S:-8}"
GRID_ODOM_SAMPLE_S="${GRID_ODOM_SAMPLE_S:-12}"
GRID_ODOM_SAMPLE_HZ="${GRID_ODOM_SAMPLE_HZ:-5}"
GRID_ODOM_DRIVE_TEST="${GRID_ODOM_DRIVE_TEST:-0}"
GRID_ODOM_DRIVE_LINEAR_X="${GRID_ODOM_DRIVE_LINEAR_X:-0.8}"
GRID_ODOM_DRIVE_ANGULAR_Z="${GRID_ODOM_DRIVE_ANGULAR_Z:-0.16}"
GRID_ODOM_DRIVE_DURATION_S="${GRID_ODOM_DRIVE_DURATION_S:-25}"
GRID_ODOM_DRIVE_RATE_HZ="${GRID_ODOM_DRIVE_RATE_HZ:-10}"
KEEP_SIM_RUNNING="${KEEP_SIM_RUNNING:-0}"
USE_KEEPOUT="${USE_KEEPOUT:-False}"
LAUNCH_WEB_APP="${LAUNCH_WEB_APP:-False}"
SIM_GLOBAL_GPS_PROFILE="${SIM_GLOBAL_GPS_PROFILE:-}"

STARTED_SIM=0

cleanup() {
  if [[ "${STARTED_SIM}" == "1" && "${KEEP_SIM_RUNNING}" != "1" ]]; then
    ./tools/stop_sim_global_v2.sh >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "ERROR: no esta corriendo el container ${CONTAINER}" >&2
  exit 2
fi

if docker exec "${CONTAINER}" pgrep -f 'sim_global_v2.launch.py' >/dev/null 2>&1; then
  echo "Usando sim_global_v2 ya levantado en ${CONTAINER}"
else
  echo "Levantando sim_global_v2 en ${CONTAINER} sin RViz/web para medir grid vs odom"
  GPS_PROFILE_ARG=""
  if [[ -n "${SIM_GLOBAL_GPS_PROFILE}" ]]; then
    GPS_PROFILE_ARG=" gps_profile:=${SIM_GLOBAL_GPS_PROFILE}"
  fi

  docker exec "${CONTAINER}" bash -lc \
    "mkdir -p /ros2_ws/logs && nohup bash -lc 'source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps sim_global_v2.launch.py launch_web_app:=${LAUNCH_WEB_APP} use_keepout:=${USE_KEEPOUT}${GPS_PROFILE_ARG}' </dev/null >/ros2_ws/logs/sim_global_v2_grid_odom_drift.log 2>&1 &"
  STARTED_SIM=1
  echo "Log: /ros2_ws/logs/sim_global_v2_grid_odom_drift.log"
fi

docker exec \
  -e MAX_GRID_ODOM_DRIFT_M="${MAX_GRID_ODOM_DRIFT_M}" \
  -e MAX_GRID_ODOM_YAW_DEG="${MAX_GRID_ODOM_YAW_DEG}" \
  -e GRID_ODOM_WAIT_TIMEOUT_S="${GRID_ODOM_WAIT_TIMEOUT_S}" \
  -e GRID_ODOM_WARMUP_S="${GRID_ODOM_WARMUP_S}" \
  -e GRID_ODOM_SAMPLE_S="${GRID_ODOM_SAMPLE_S}" \
  -e GRID_ODOM_SAMPLE_HZ="${GRID_ODOM_SAMPLE_HZ}" \
  -e GRID_ODOM_DRIVE_TEST="${GRID_ODOM_DRIVE_TEST}" \
  -e GRID_ODOM_DRIVE_LINEAR_X="${GRID_ODOM_DRIVE_LINEAR_X}" \
  -e GRID_ODOM_DRIVE_ANGULAR_Z="${GRID_ODOM_DRIVE_ANGULAR_Z}" \
  -e GRID_ODOM_DRIVE_DURATION_S="${GRID_ODOM_DRIVE_DURATION_S}" \
  -e GRID_ODOM_DRIVE_RATE_HZ="${GRID_ODOM_DRIVE_RATE_HZ}" \
  "${CONTAINER}" \
  bash -lc 'source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && python3 - <<'"'"'PY'"'"'
import math
import os
import statistics
import sys
import time

from geometry_msgs.msg import Twist
import rclpy
from rclpy.time import Time
from tf2_ros import Buffer, TransformException, TransformListener


def env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        print(f"ERROR: {name} debe ser numerico", file=sys.stderr)
        sys.exit(2)


def yaw_from_quaternion(q):
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    return math.atan2(siny_cosp, cosy_cosp)


max_drift_m = env_float("MAX_GRID_ODOM_DRIFT_M", "1.0")
max_yaw_deg = env_float("MAX_GRID_ODOM_YAW_DEG", "5.0")
wait_timeout_s = env_float("GRID_ODOM_WAIT_TIMEOUT_S", "45")
warmup_s = env_float("GRID_ODOM_WARMUP_S", "8")
sample_s = env_float("GRID_ODOM_SAMPLE_S", "12")
sample_hz = env_float("GRID_ODOM_SAMPLE_HZ", "5")
drive_test = os.environ.get("GRID_ODOM_DRIVE_TEST", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
drive_linear_x = env_float("GRID_ODOM_DRIVE_LINEAR_X", "0.8")
drive_angular_z = env_float("GRID_ODOM_DRIVE_ANGULAR_Z", "0.16")
drive_duration_s = env_float("GRID_ODOM_DRIVE_DURATION_S", "25")
drive_rate_hz = env_float("GRID_ODOM_DRIVE_RATE_HZ", "10")
sample_period_s = 1.0 / max(sample_hz, 0.1)
drive_period_s = 1.0 / max(drive_rate_hz, 0.1)

rclpy.init()
node = rclpy.create_node("grid_odom_drift_probe")
tf_buffer = Buffer()
tf_listener = TransformListener(tf_buffer, node)
drive_pub = node.create_publisher(Twist, "/cmd_vel_safe", 10) if drive_test else None

deadline = time.monotonic() + wait_timeout_s
last_error = None
first_transform = None

while time.monotonic() < deadline:
    rclpy.spin_once(node, timeout_sec=0.05)
    try:
        first_transform = tf_buffer.lookup_transform("map", "odom", Time())
        break
    except TransformException as exc:
        last_error = str(exc)
        time.sleep(0.05)

if first_transform is None:
    node.destroy_node()
    rclpy.shutdown()
    print(
        "FAIL: no aparecio TF map->odom "
        f"en {wait_timeout_s:.1f}s. ultimo error: {last_error}",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    "TF map->odom disponible; "
    f"warmup={warmup_s:.1f}s sample={sample_s:.1f}s "
    f"limites={max_drift_m:.2f}m/{max_yaw_deg:.2f}deg "
    f"drive_test={int(drive_test)}"
)

warmup_deadline = time.monotonic() + warmup_s
while time.monotonic() < warmup_deadline:
    rclpy.spin_once(node, timeout_sec=0.05)
    time.sleep(0.05)

samples = []
sample_deadline = time.monotonic() + sample_s
next_sample = time.monotonic()
drive_deadline = time.monotonic() + drive_duration_s
next_drive = time.monotonic()


def publish_drive(linear_x: float, angular_z: float) -> None:
    if drive_pub is None:
        return
    cmd = Twist()
    cmd.linear.x = float(linear_x)
    cmd.angular.z = float(angular_z)
    drive_pub.publish(cmd)

while time.monotonic() < sample_deadline:
    rclpy.spin_once(node, timeout_sec=0.05)
    now = time.monotonic()
    if drive_test and now <= drive_deadline and now >= next_drive:
        next_drive = now + drive_period_s
        publish_drive(drive_linear_x, drive_angular_z)
    if now < next_sample:
        continue
    next_sample = now + sample_period_s
    try:
        tf = tf_buffer.lookup_transform("map", "odom", Time())
    except TransformException as exc:
        print(f"WARN: salto muestra sin TF map->odom: {exc}", file=sys.stderr)
        continue

    tr = tf.transform.translation
    rot = tf.transform.rotation
    yaw_deg = math.degrees(yaw_from_quaternion(rot))
    samples.append(
        {
            "x": tr.x,
            "y": tr.y,
            "distance": math.hypot(tr.x, tr.y),
            "yaw_deg": yaw_deg,
        }
)

if drive_test:
    for _ in range(5):
        publish_drive(0.0, 0.0)
        rclpy.spin_once(node, timeout_sec=0.02)

node.destroy_node()
rclpy.shutdown()

if not samples:
    print("FAIL: no se pudo tomar ninguna muestra de TF map->odom", file=sys.stderr)
    sys.exit(1)

distances = [sample["distance"] for sample in samples]
yaws = [abs(sample["yaw_deg"]) for sample in samples]
first = samples[0]
last = samples[-1]
max_distance = max(distances)
mean_distance = statistics.fmean(distances)
max_yaw = max(yaws)
first_x = first["x"]
first_y = first["y"]
first_yaw = first["yaw_deg"]
last_x = last["x"]
last_y = last["y"]
last_yaw = last["yaw_deg"]

print(
    "GRID_ODOM_DRIFT "
    f"samples={len(samples)} "
    f"mean_translation_m={mean_distance:.3f} "
    f"max_translation_m={max_distance:.3f} "
    f"max_yaw_deg={max_yaw:.3f}"
)
print(
    "GRID_ODOM_FIRST_LAST "
    f"first_x={first_x:.3f} first_y={first_y:.3f} first_yaw_deg={first_yaw:.3f} "
    f"last_x={last_x:.3f} last_y={last_y:.3f} last_yaw_deg={last_yaw:.3f}"
)
sys.stdout.flush()

failed = False
if max_distance > max_drift_m:
    print(
        f"FAIL: map->odom se separo {max_distance:.3f}m; "
        f"limite {max_drift_m:.3f}m",
        file=sys.stderr,
    )
    failed = True
if max_yaw > max_yaw_deg:
    print(
        f"FAIL: map->odom giro {max_yaw:.3f}deg; "
        f"limite {max_yaw_deg:.3f}deg",
        file=sys.stderr,
    )
    failed = True

if failed:
    sys.exit(1)

print("OK: grid map y grid odom se mantienen dentro del umbral")
PY'

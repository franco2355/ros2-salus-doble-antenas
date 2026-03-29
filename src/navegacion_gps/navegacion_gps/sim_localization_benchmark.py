from __future__ import annotations

import argparse
import json
import math
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import rclpy
from diagnostic_msgs.msg import DiagnosticArray
from geographic_msgs.msg import GeoPoint
from geometry_msgs.msg import PointStamped
from interfaces.msg import NavEvent
from interfaces.srv import SetNavGoalLL
from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.time import Time
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix
import tf2_geometry_msgs  # noqa: F401
from tf2_ros import Buffer, TransformListener


DEFAULT_GOAL_LAT = -31.4857786
DEFAULT_GOAL_LON = -64.2404348
IDLE_SAMPLE_INTERVAL_S = 2.0
MAX_BENCHMARK_ATTEMPTS = 2


def _distance_xy(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _bool_to_launch_arg(value: bool) -> str:
    return "True" if value else "False"


def _uint8_to_int(value: Any) -> int:
    if isinstance(value, (bytes, bytearray)):
        return int(value[0])
    return int(value)


def _pose_covariance_summary(msg: Odometry) -> dict[str, float]:
    covariance = msg.pose.covariance
    return {
        "x": float(covariance[0]),
        "y": float(covariance[7]),
        "yaw": float(covariance[35]),
    }


def _mean(values: list[float]) -> float:
    return sum(values) / float(len(values)) if values else 0.0


def _run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)


def _active_ros_nodes() -> list[str]:
    result = _run_command(["ros2", "node", "list"])
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _refresh_ros_graph() -> None:
    _run_command(["ros2", "daemon", "stop"])
    _run_command(["ros2", "daemon", "start"])


def _tail_file(path: Path, line_count: int = 80) -> str:
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-line_count:])


def _cleanup_launch_process(
    proc: Optional[subprocess.Popen[Any]], *, timeout_s: float = 20.0
) -> None:
    if proc is None:
        return
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    end = time.time() + timeout_s
    while time.time() < end:
        if proc.poll() is not None:
            return
        time.sleep(0.2)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass


def _wait_for_clean_runtime(
    timeout_s: float = 45.0, *, stable_empty_polls: int = 2
) -> list[str]:
    end = time.time() + timeout_s
    last_nodes: list[str] = []
    empty_polls = 0
    while time.time() < end:
        last_nodes = _active_ros_nodes()
        if not last_nodes:
            empty_polls += 1
            if empty_polls >= stable_empty_polls:
                return []
        else:
            empty_polls = 0
        time.sleep(1.0)
    if last_nodes:
        _refresh_ros_graph()
        time.sleep(1.0)
        return _active_ros_nodes()
    return last_nodes


class BenchmarkProbe(Node):
    def __init__(self) -> None:
        super().__init__("sim_localization_benchmark")
        self.gps_fix: Optional[NavSatFix] = None
        self.odom_local: Optional[Odometry] = None
        self.odom_gps: Optional[Odometry] = None
        self.latest_diag_map: Optional[dict[str, Any]] = None
        self.events: list[dict[str, Any]] = []
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self, spin_thread=False)
        self.create_subscription(NavSatFix, "/gps/fix", self._on_gps_fix, 10)
        self.create_subscription(Odometry, "/odometry/local", self._on_odom_local, 10)
        self.create_subscription(Odometry, "/odometry/gps", self._on_odom_gps, 10)
        self.create_subscription(DiagnosticArray, "/diagnostics", self._on_diagnostics, 10)
        self.create_subscription(NavEvent, "/nav_command_server/events", self._on_nav_event, 100)
        self.fromll_client = self.create_client(FromLL, "/fromLL")
        self.goal_client = self.create_client(SetNavGoalLL, "/nav_command_server/set_goal_ll")

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        self.gps_fix = msg

    def _on_odom_local(self, msg: Odometry) -> None:
        self.odom_local = msg

    def _on_odom_gps(self, msg: Odometry) -> None:
        self.odom_gps = msg

    def _on_diagnostics(self, msg: DiagnosticArray) -> None:
        for status in msg.status:
            if status.name == "ekf_filter_node_map: Filter diagnostic updater":
                self.latest_diag_map = {
                    "level": _uint8_to_int(status.level),
                    "message": status.message,
                    "values": {item.key: item.value for item in status.values},
                }
                return

    def _on_nav_event(self, msg: NavEvent) -> None:
        self.events.append(
            {
                "time_sec": float(msg.stamp.sec) + float(msg.stamp.nanosec) / 1_000_000_000.0,
                "severity": _uint8_to_int(msg.severity),
                "component": msg.component,
                "code": msg.code,
                "message": msg.message,
            }
        )

    def spin_until(self, predicate, timeout_s: float) -> bool:
        end = time.time() + timeout_s
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if predicate():
                return True
        return False

    def wait_for_bootstrap(self, timeout_s: float) -> bool:
        if not self.fromll_client.wait_for_service(timeout_sec=timeout_s):
            return False
        if not self.goal_client.wait_for_service(timeout_sec=timeout_s):
            return False
        return self.spin_until(
            lambda: self.gps_fix is not None
            and self.odom_local is not None
            and self.odom_gps is not None
            and self.latest_diag_map is not None,
            timeout_s=timeout_s,
        )

    def lookup_xy(
        self, target_frame: str, source_frame: str, timeout_s: float = 1.0
    ) -> tuple[float, float]:
        transform = self.tf_buffer.lookup_transform(
            target_frame,
            source_frame,
            Time(),
            timeout=Duration(seconds=timeout_s),
        )
        return (
            float(transform.transform.translation.x),
            float(transform.transform.translation.y),
        )

    def lookup_xy_retry(
        self,
        target_frame: str,
        source_frame: str,
        timeout_s: float = 5.0,
    ) -> tuple[float, float]:
        end = time.time() + timeout_s
        while time.time() < end:
            try:
                return self.lookup_xy(target_frame, source_frame, timeout_s=0.5)
            except Exception:
                rclpy.spin_once(self, timeout_sec=0.1)
        raise RuntimeError(f"timeout waiting for TF {target_frame}->{source_frame}")

    def fromll_to_map(self, lat: float, lon: float, timeout_s: float = 5.0) -> dict[str, Any]:
        request = FromLL.Request()
        request.ll_point = GeoPoint(latitude=float(lat), longitude=float(lon), altitude=0.0)
        future = self.fromll_client.call_async(request)
        end = time.time() + timeout_s
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                response = future.result()
                stamped_point = PointStamped()
                stamped_point.header.frame_id = "odom"
                stamped_point.header.stamp = Time().to_msg()
                stamped_point.point.x = float(response.map_point.x)
                stamped_point.point.y = float(response.map_point.y)
                stamped_point.point.z = 0.0
                transformed = self.tf_buffer.transform(
                    stamped_point,
                    "map",
                    timeout=Duration(seconds=1.0),
                )
                return {
                    "raw_odom_xy": [
                        float(response.map_point.x),
                        float(response.map_point.y),
                    ],
                    "map_xy": [
                        float(transformed.point.x),
                        float(transformed.point.y),
                    ],
                }
        raise RuntimeError("timeout waiting for /fromLL response")

    def sample_idle_drift(self, duration_s: float) -> dict[str, Any]:
        samples: list[dict[str, Any]] = []
        end = time.time() + duration_s + 4.0
        while time.time() < end and len(samples) < max(
            2, int(duration_s / IDLE_SAMPLE_INTERVAL_S)
        ):
            rclpy.spin_once(self, timeout_sec=0.1)
            if self.gps_fix is None or self.odom_local is None or self.odom_gps is None:
                continue
            try:
                gps_projection = self.fromll_to_map(
                    self.gps_fix.latitude,
                    self.gps_fix.longitude,
                )
                map_base = self.lookup_xy("map", "base_footprint", timeout_s=0.5)
                odom_base = self.lookup_xy("odom", "base_footprint", timeout_s=0.5)
                map_odom = self.lookup_xy("map", "odom", timeout_s=0.5)
            except Exception:
                time.sleep(0.2)
                continue
            samples.append(
                {
                    "gps_lat": float(self.gps_fix.latitude),
                    "gps_lon": float(self.gps_fix.longitude),
                    "fromll_odom_xy": gps_projection["raw_odom_xy"],
                    "fromll_map_xy": gps_projection["map_xy"],
                    "navsat_vs_fromll_odom_delta_m": _distance_xy(
                        tuple(gps_projection["raw_odom_xy"]),
                        (
                            float(self.odom_gps.pose.pose.position.x),
                            float(self.odom_gps.pose.pose.position.y),
                        ),
                    ),
                    "map_base_xy": [float(map_base[0]), float(map_base[1])],
                    "odom_base_xy": [float(odom_base[0]), float(odom_base[1])],
                    "map_odom_xy": [float(map_odom[0]), float(map_odom[1])],
                    "odom_local_xy": [
                        float(self.odom_local.pose.pose.position.x),
                        float(self.odom_local.pose.pose.position.y),
                    ],
                    "odom_gps_xy": [
                        float(self.odom_gps.pose.pose.position.x),
                        float(self.odom_gps.pose.pose.position.y),
                    ],
                    "odom_local_covariance": _pose_covariance_summary(self.odom_local),
                    "odom_gps_covariance": _pose_covariance_summary(self.odom_gps),
                }
            )
            time.sleep(IDLE_SAMPLE_INTERVAL_S)

        if len(samples) < 2:
            raise RuntimeError("insufficient idle samples")

        first = samples[0]
        last = samples[-1]
        navsat_transform_drift = max(
            _distance_xy(tuple(first["fromll_odom_xy"]), tuple(last["fromll_odom_xy"])),
            _distance_xy(tuple(first["odom_gps_xy"]), tuple(last["odom_gps_xy"])),
        )
        global_fusion_drift = _distance_xy(
            tuple(first["map_odom_xy"]), tuple(last["map_odom_xy"])
        )
        fusion_added_drift = max(0.0, global_fusion_drift - navsat_transform_drift)
        return {
            "sample_count": len(samples),
            "first_sample": first,
            "last_sample": last,
            "drift_m": {
                "map_odom": global_fusion_drift,
                "map_base": _distance_xy(
                    tuple(first["map_base_xy"]), tuple(last["map_base_xy"])
                ),
                "odom_base": _distance_xy(
                    tuple(first["odom_base_xy"]), tuple(last["odom_base_xy"])
                ),
                "fromll_map": _distance_xy(
                    tuple(first["fromll_map_xy"]), tuple(last["fromll_map_xy"])
                ),
                "fromll_odom": _distance_xy(
                    tuple(first["fromll_odom_xy"]), tuple(last["fromll_odom_xy"])
                ),
                "odom_gps": _distance_xy(
                    tuple(first["odom_gps_xy"]), tuple(last["odom_gps_xy"])
                ),
            },
            "odometry_gps_covariance": {
                "first": first["odom_gps_covariance"],
                "last": last["odom_gps_covariance"],
                "mean": {
                    axis: _mean([float(sample["odom_gps_covariance"][axis]) for sample in samples])
                    for axis in ("x", "y", "yaw")
                },
            },
            "odometry_local_covariance": {
                "first": first["odom_local_covariance"],
                "last": last["odom_local_covariance"],
                "mean": {
                    axis: _mean(
                        [float(sample["odom_local_covariance"][axis]) for sample in samples]
                    )
                    for axis in ("x", "y", "yaw")
                },
            },
            "navsat_consistency": {
                "delta_fromll_to_odom_gps_first_m": float(first["navsat_vs_fromll_odom_delta_m"]),
                "delta_fromll_to_odom_gps_last_m": float(last["navsat_vs_fromll_odom_delta_m"]),
                "delta_fromll_to_odom_gps_mean_m": _mean(
                    [float(sample["navsat_vs_fromll_odom_delta_m"]) for sample in samples]
                ),
            },
            "drift_attribution": {
                "navsat_transform_drift_m": navsat_transform_drift,
                "global_fusion_drift_m": global_fusion_drift,
                "fusion_added_drift_m": fusion_added_drift,
                "likely_origin": (
                    "fusion_with_odometry_local"
                    if global_fusion_drift > max(1.5, navsat_transform_drift * 2.0)
                    else (
                        "navsat_transform_or_gps"
                        if navsat_transform_drift > 1.0
                        else "mixed_or_inconclusive"
                    )
                ),
            },
        }

    def run_goal_test(
        self,
        *,
        lat: float,
        lon: float,
        yaw_deg: float,
        timeout_s: float,
    ) -> dict[str, Any]:
        goal_projection = self.fromll_to_map(lat, lon)
        start_map_base = list(self.lookup_xy_retry("map", "base_footprint"))
        request = SetNavGoalLL.Request()
        request.lat = float(lat)
        request.lon = float(lon)
        request.yaw_deg = float(yaw_deg)
        request.loop = False
        future = self.goal_client.call_async(request)
        end = time.time() + 10.0
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                break
        if not future.done():
            raise RuntimeError("timeout waiting for set_goal_ll response")
        response = future.result()
        goal_result: dict[str, Any] = {
            "goal_projection": goal_projection,
            "start_map_base_xy": start_map_base,
            "service_ok": bool(response.ok),
            "service_error": str(response.error),
            "terminal_event_code": "",
            "terminal_event_message": "",
            "last_events": [],
        }
        if not response.ok:
            return goal_result

        terminal_codes = {"GOAL_FAILED", "GOAL_COMPLETED", "GOAL_REJECTED"}
        start = time.time()
        terminal_event: Optional[dict[str, Any]] = None
        while time.time() - start < timeout_s:
            rclpy.spin_once(self, timeout_sec=0.2)
            if self.events and self.events[-1]["code"] in terminal_codes:
                terminal_event = self.events[-1]
                break
        end_map_base = list(self.lookup_xy_retry("map", "base_footprint"))
        goal_map_xy = tuple(goal_projection["map_xy"])
        goal_result.update(
            {
                "end_map_base_xy": end_map_base,
                "distance_to_goal_start_m": _distance_xy(tuple(start_map_base), goal_map_xy),
                "distance_to_goal_end_m": _distance_xy(tuple(end_map_base), goal_map_xy),
                "last_events": self.events[-12:],
            }
        )
        if terminal_event is not None:
            goal_result["terminal_event_code"] = terminal_event["code"]
            goal_result["terminal_event_message"] = terminal_event["message"]
        return goal_result


def _launch_simulation(
    *,
    profile: str,
    realism_mode: bool,
    custom_params_file: str,
) -> tuple[subprocess.Popen[Any], Path]:
    log_fd, log_path_str = tempfile.mkstemp(
        prefix=f"sim_localization_{profile}_{'real' if realism_mode else 'legacy'}_",
        suffix=".log",
    )
    os.close(log_fd)
    log_path = Path(log_path_str)
    log_file = open(log_path, "w", encoding="utf-8")
    launch_cmd = [
        "ros2",
        "launch",
        "navegacion_gps",
        "simulacion.launch.py",
        "use_rviz:=False",
        "use_mapviz:=False",
        f"realism_mode:={_bool_to_launch_arg(realism_mode)}",
        f"sim_localization_profile:={profile}",
    ]
    if custom_params_file:
        launch_cmd.append(f"sim_localization_params_file:={custom_params_file}")
    process = subprocess.Popen(
        launch_cmd,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    return process, log_path


def _run_single_benchmark(
    *,
    profile: str,
    realism_mode: bool,
    idle_duration_s: float,
    drift_threshold_m: float,
    with_goal: bool,
    goal_timeout_s: float,
    goal_lat: float,
    goal_lon: float,
    goal_yaw_deg: float,
    custom_params_file: str,
) -> dict[str, Any]:
    last_error: Optional[RuntimeError] = None
    for attempt in range(1, MAX_BENCHMARK_ATTEMPTS + 1):
        try:
            return _run_single_benchmark_once(
                profile=profile,
                realism_mode=realism_mode,
                idle_duration_s=idle_duration_s,
                drift_threshold_m=drift_threshold_m,
                with_goal=with_goal,
                goal_timeout_s=goal_timeout_s,
                goal_lat=goal_lat,
                goal_lon=goal_lon,
                goal_yaw_deg=goal_yaw_deg,
                custom_params_file=custom_params_file,
            )
        except RuntimeError as exc:
            last_error = exc
            if attempt >= MAX_BENCHMARK_ATTEMPTS:
                raise
            error_text = str(exc)
            if (
                "simulation bootstrap failed" not in error_text
                and "insufficient idle samples" not in error_text
            ):
                raise
            print(
                f"[benchmark] retrying profile={profile} realism_mode={realism_mode} "
                f"after transient failure on attempt {attempt}: {error_text.splitlines()[0]}",
                flush=True,
            )
            _refresh_ros_graph()
            time.sleep(2.0)
    if last_error is not None:
        raise last_error
    raise RuntimeError("benchmark attempt loop ended unexpectedly")


def _run_single_benchmark_once(
    *,
    profile: str,
    realism_mode: bool,
    idle_duration_s: float,
    drift_threshold_m: float,
    with_goal: bool,
    goal_timeout_s: float,
    goal_lat: float,
    goal_lon: float,
    goal_yaw_deg: float,
    custom_params_file: str,
) -> dict[str, Any]:
    preexisting_nodes = _active_ros_nodes()
    if preexisting_nodes:
        _refresh_ros_graph()
        preexisting_nodes = _active_ros_nodes()
    if preexisting_nodes:
        raise RuntimeError(
            "runtime is not clean; active nodes detected: " + ", ".join(preexisting_nodes)
        )

    launch_proc: Optional[subprocess.Popen[Any]] = None
    launch_log_path: Optional[Path] = None
    rclpy.init()
    probe = BenchmarkProbe()
    try:
        launch_proc, launch_log_path = _launch_simulation(
            profile=profile,
            realism_mode=realism_mode,
            custom_params_file=custom_params_file,
        )
        bootstrap_timeout_s = 60.0
        bootstrap_ok = probe.wait_for_bootstrap(bootstrap_timeout_s)
        if (launch_proc.poll() is not None) or (not bootstrap_ok):
            raise RuntimeError(
                "simulation bootstrap failed\n" + _tail_file(launch_log_path or Path())
            )

        idle_result = probe.sample_idle_drift(idle_duration_s)
        diag_map = probe.latest_diag_map or {}
        idle_pass = (
            bool(diag_map)
            and int(diag_map.get("level", 2)) == 0
            and float(idle_result["drift_m"]["map_odom"]) <= float(drift_threshold_m)
        )

        result: dict[str, Any] = {
            "profile": profile,
            "realism_mode": realism_mode,
            "launch_log_path": str(launch_log_path),
            "diagnostics_map": diag_map,
            "idle_result": idle_result,
            "idle_pass": idle_pass,
        }
        if with_goal and idle_pass:
            result["goal_result"] = probe.run_goal_test(
                lat=goal_lat,
                lon=goal_lon,
                yaw_deg=goal_yaw_deg,
                timeout_s=goal_timeout_s,
            )
        else:
            result["goal_result"] = None
        return result
    finally:
        probe.destroy_node()
        rclpy.shutdown()
        _cleanup_launch_process(launch_proc)
        leftover_nodes = _wait_for_clean_runtime()
        if leftover_nodes and launch_log_path is not None:
            raise RuntimeError(
                "runtime did not cleanly shut down; active nodes: "
                + ", ".join(leftover_nodes)
                + "\n"
                + _tail_file(launch_log_path)
            )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark idle drift of simulation localization profiles."
    )
    parser.add_argument(
        "--profile",
        action="append",
        choices=[
            "baseline",
            "navsat_imu_heading",
            "decouple_global_yaw",
            "decouple_global_twist_only",
            "decouple_global_linear_twist_only",
        ],
        help="Simulation localization profile to run. Repeat for multiple profiles.",
    )
    parser.add_argument(
        "--realism-mode",
        action="append",
        choices=["false", "true"],
        help="Simulation realism mode to run. Repeat for both modes.",
    )
    parser.add_argument(
        "--sim-localization-params-file",
        default="",
        help="Optional localization overlay params file for simulation.",
    )
    parser.add_argument("--idle-seconds", type=float, default=20.0)
    parser.add_argument("--drift-threshold-m", type=float, default=1.0)
    parser.add_argument("--with-goal", action="store_true")
    parser.add_argument("--goal-timeout-s", type=float, default=75.0)
    parser.add_argument("--goal-lat", type=float, default=DEFAULT_GOAL_LAT)
    parser.add_argument("--goal-lon", type=float, default=DEFAULT_GOAL_LON)
    parser.add_argument("--goal-yaw-deg", type=float, default=0.0)
    parser.add_argument("--output", default="", help="Optional path to write JSON results.")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    profiles = args.profile or [
        "baseline",
        "navsat_imu_heading",
        "decouple_global_yaw",
        "decouple_global_twist_only",
        "decouple_global_linear_twist_only",
    ]
    realism_modes = (
        [mode == "true" for mode in args.realism_mode]
        if args.realism_mode
        else [False]
    )
    results: list[dict[str, Any]] = []
    for realism_mode in realism_modes:
        for profile in profiles:
            print(
                f"[benchmark] running profile={profile} realism_mode={realism_mode}",
                flush=True,
            )
            result = _run_single_benchmark(
                profile=profile,
                realism_mode=realism_mode,
                idle_duration_s=args.idle_seconds,
                drift_threshold_m=args.drift_threshold_m,
                with_goal=args.with_goal,
                goal_timeout_s=args.goal_timeout_s,
                goal_lat=args.goal_lat,
                goal_lon=args.goal_lon,
                goal_yaw_deg=args.goal_yaw_deg,
                custom_params_file=args.sim_localization_params_file,
            )
            results.append(result)
    payload = {"results": results}
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

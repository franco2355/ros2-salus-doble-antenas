from __future__ import annotations

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import statistics
import time
from typing import Any, Optional

import rclpy
from geographic_msgs.msg import GeoPoint
from geometry_msgs.msg import PointStamped
from interfaces.msg import DriveTelemetry, NavEvent
from interfaces.srv import SetNavGoalLL
from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.time import Time
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix
from std_msgs.msg import String
import tf2_geometry_msgs  # noqa: F401
from tf2_msgs.msg import TFMessage

from navegacion_gps.gps_course_heading_core import ros_yaw_deg_from_north_east
from navegacion_gps.heading_math import AngleSeries
from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.heading_math import yaw_deg_from_quaternion_xyzw


TERMINAL_EVENT_CODES = {
    "GOAL_COMPLETED",
    "GOAL_FAILED",
    "GOAL_REJECTED",
    "GOAL_RESULT_SUCCEEDED",
    "GOAL_RESULT_ABORTED",
}
BOOTSTRAP_TIMEOUT_S = 45.0


def _mean(values: list[float]) -> Optional[float]:
    return float(statistics.fmean(values)) if values else None


def _std(values: list[float]) -> Optional[float]:
    return float(statistics.pstdev(values)) if len(values) >= 2 else 0.0 if values else None


def _span(values: list[float]) -> Optional[float]:
    return float(max(values) - min(values)) if values else None


def _distance_xy(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(float(a[0]) - float(b[0]), float(a[1]) - float(b[1]))


def _stamp_to_seconds(stamp) -> float:
    return float(stamp.sec) + float(stamp.nanosec) / 1_000_000_000.0


def _meters_per_deg_lon(lat_deg: float) -> float:
    return 111_320.0 * max(1.0e-6, abs(math.cos(math.radians(float(lat_deg)))))


def _offset_lat_lon(lat_deg: float, lon_deg: float, north_m: float, east_m: float) -> tuple[float, float]:
    lat = float(lat_deg) + float(north_m) / 111_320.0
    lon = float(lon_deg) + float(east_m) / _meters_per_deg_lon(lat_deg)
    return lat, lon


def _line_lateral_error_m(
    point_xy: tuple[float, float],
    line_start_xy: tuple[float, float],
    line_end_xy: tuple[float, float],
) -> float:
    line_dx = float(line_end_xy[0]) - float(line_start_xy[0])
    line_dy = float(line_end_xy[1]) - float(line_start_xy[1])
    line_norm = math.hypot(line_dx, line_dy)
    if line_norm < 1.0e-6:
        return 0.0
    rel_x = float(point_xy[0]) - float(line_start_xy[0])
    rel_y = float(point_xy[1]) - float(line_start_xy[1])
    return ((rel_x * line_dy) - (rel_y * line_dx)) / line_norm


def _json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_ready(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_ready(item) for item in value]
    if isinstance(value, float):
        return None if not math.isfinite(value) else float(value)
    return value


class StraightBenchmarkNode(Node):
    def __init__(self) -> None:
        super().__init__(
            "sim_global_straight_benchmark",
            parameter_overrides=[],
            automatically_declare_parameters_from_overrides=True,
        )
        if not self.has_parameter("use_sim_time"):
            self.declare_parameter("use_sim_time", True)

        self.gps_fix: Optional[NavSatFix] = None
        self.odom_local: Optional[Odometry] = None
        self.odom_gps: Optional[Odometry] = None
        self.odom_global: Optional[Odometry] = None
        self.drive_telemetry: Optional[DriveTelemetry] = None
        self.course_debug: dict[str, Any] = {}
        self.events: list[dict[str, Any]] = []

        self.create_subscription(NavSatFix, "/gps/fix", self._on_gps_fix, 10)
        self.create_subscription(Odometry, "/odometry/local", self._on_odom_local, 10)
        self.create_subscription(Odometry, "/odometry/gps", self._on_odom_gps, 10)
        self.create_subscription(Odometry, "/odometry/global", self._on_odom_global, 10)
        self.create_subscription(DriveTelemetry, "/controller/drive_telemetry", self._on_drive, 10)
        self.create_subscription(String, "/gps/course_heading/debug", self._on_course_debug, 50)
        self.create_subscription(NavEvent, "/nav_command_server/events", self._on_nav_event, 100)
        self.create_subscription(TFMessage, "/tf", self._on_tf, 100)

        self.fromll_client = self.create_client(FromLL, "/fromLL")
        self.goal_client = self.create_client(SetNavGoalLL, "/nav_command_server/set_goal_ll")
        self.latest_map_odom_tf: Optional[dict[str, float]] = None

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        self.gps_fix = msg

    def _on_odom_local(self, msg: Odometry) -> None:
        self.odom_local = msg

    def _on_odom_gps(self, msg: Odometry) -> None:
        self.odom_gps = msg

    def _on_odom_global(self, msg: Odometry) -> None:
        self.odom_global = msg

    def _on_drive(self, msg: DriveTelemetry) -> None:
        self.drive_telemetry = msg

    def _on_course_debug(self, msg: String) -> None:
        try:
            parsed = json.loads(msg.data)
        except Exception:
            return
        if isinstance(parsed, dict):
            self.course_debug = dict(parsed)

    def _on_nav_event(self, msg: NavEvent) -> None:
        self.events.append(
            {
                "time_sec": float(msg.stamp.sec) + float(msg.stamp.nanosec) / 1_000_000_000.0,
                "severity": int(msg.severity),
                "component": msg.component,
                "code": msg.code,
                "message": msg.message,
            }
        )

    def _on_tf(self, msg: TFMessage) -> None:
        for transform in msg.transforms:
            if transform.header.frame_id != "map" or transform.child_frame_id != "odom":
                continue
            rotation = transform.transform.rotation
            self.latest_map_odom_tf = {
                "x": float(transform.transform.translation.x),
                "y": float(transform.transform.translation.y),
                "yaw_deg": float(
                    yaw_deg_from_quaternion_xyzw(
                        rotation.x,
                        rotation.y,
                        rotation.z,
                        rotation.w,
                    )
                ),
            }

    def spin_until(self, predicate, timeout_s: float) -> bool:
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if predicate():
                return True
        return False

    def wait_for_bootstrap(self, timeout_s: float = BOOTSTRAP_TIMEOUT_S) -> bool:
        if not self.fromll_client.wait_for_service(timeout_sec=timeout_s):
            return False
        if not self.goal_client.wait_for_service(timeout_sec=timeout_s):
            return False
        return self.spin_until(
            lambda: self.gps_fix is not None
            and self.odom_local is not None
            and self.odom_gps is not None
            and self.odom_global is not None
            and self.drive_telemetry is not None
            and self.latest_map_odom_tf is not None,
            timeout_s=timeout_s,
        )

    def _map_odom_pose(self) -> tuple[float, float, float]:
        if self.latest_map_odom_tf is None:
            raise RuntimeError("missing latest map->odom tf")
        return (
            float(self.latest_map_odom_tf["x"]),
            float(self.latest_map_odom_tf["y"]),
            float(self.latest_map_odom_tf["yaw_deg"]),
        )

    def _transform_odom_xy_to_map(self, x: float, y: float) -> tuple[float, float]:
        map_odom_x, map_odom_y, map_odom_yaw_deg = self._map_odom_pose()
        yaw_rad = math.radians(float(map_odom_yaw_deg))
        cos_yaw = math.cos(yaw_rad)
        sin_yaw = math.sin(yaw_rad)
        map_x = float(map_odom_x) + (cos_yaw * float(x)) - (sin_yaw * float(y))
        map_y = float(map_odom_y) + (sin_yaw * float(x)) + (cos_yaw * float(y))
        return float(map_x), float(map_y)

    def _map_base_from_local(self) -> tuple[float, float, float]:
        if self.odom_local is None:
            raise RuntimeError("missing /odometry/local")
        odom_local_yaw_deg = yaw_deg_from_quaternion_xyzw(
            self.odom_local.pose.pose.orientation.x,
            self.odom_local.pose.pose.orientation.y,
            self.odom_local.pose.pose.orientation.z,
            self.odom_local.pose.pose.orientation.w,
        )
        map_x, map_y = self._transform_odom_xy_to_map(
            float(self.odom_local.pose.pose.position.x),
            float(self.odom_local.pose.pose.position.y),
        )
        _, _, map_odom_yaw_deg = self._map_odom_pose()
        return (
            float(map_x),
            float(map_y),
            float(normalize_yaw_deg(map_odom_yaw_deg + odom_local_yaw_deg)),
        )

    def fromll_to_map(self, lat: float, lon: float, timeout_s: float = 5.0) -> dict[str, Any]:
        request = FromLL.Request()
        request.ll_point = GeoPoint(latitude=float(lat), longitude=float(lon), altitude=0.0)
        future = self.fromll_client.call_async(request)
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                response = future.result()
                map_xy = self._transform_odom_xy_to_map(
                    float(response.map_point.x),
                    float(response.map_point.y),
                )
                return {
                    "raw_odom_xy": [
                        float(response.map_point.x),
                        float(response.map_point.y),
                    ],
                    "map_xy": [float(map_xy[0]), float(map_xy[1])],
                }
        raise RuntimeError("timeout waiting for /fromLL response")

    def send_goal(self, lat: float, lon: float, yaw_deg: float, timeout_s: float = 10.0) -> dict[str, Any]:
        request = SetNavGoalLL.Request()
        request.lat = float(lat)
        request.lon = float(lon)
        request.yaw_deg = float(yaw_deg)
        request.loop = False
        future = self.goal_client.call_async(request)
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                response = future.result()
                return {"ok": bool(response.ok), "error": str(response.error)}
        raise RuntimeError("timeout waiting for /nav_command_server/set_goal_ll response")

    def latest_terminal_event(self) -> Optional[dict[str, Any]]:
        for event in reversed(self.events):
            if event["code"] in TERMINAL_EVENT_CODES:
                return event
        return None

    def sample_snapshot(
        self,
        *,
        phase: str,
        t_rel_s: float,
        line_start_xy: tuple[float, float],
        line_end_xy: tuple[float, float],
    ) -> Optional[dict[str, Any]]:
        if (
            self.gps_fix is None
            or self.odom_local is None
            or self.odom_gps is None
            or self.odom_global is None
            or self.drive_telemetry is None
        ):
            return None

        try:
            map_odom_x, map_odom_y, map_odom_yaw_deg = self._map_odom_pose()
            map_base_x, map_base_y, map_base_yaw_deg = self._map_base_from_local()
            odom_gps_map_x, odom_gps_map_y = self._transform_odom_xy_to_map(
                float(self.odom_gps.pose.pose.position.x),
                float(self.odom_gps.pose.pose.position.y),
            )
        except Exception:
            return None

        odom_local_yaw_deg = yaw_deg_from_quaternion_xyzw(
            self.odom_local.pose.pose.orientation.x,
            self.odom_local.pose.pose.orientation.y,
            self.odom_local.pose.pose.orientation.z,
            self.odom_local.pose.pose.orientation.w,
        )
        odom_global_yaw_deg = yaw_deg_from_quaternion_xyzw(
            self.odom_global.pose.pose.orientation.x,
            self.odom_global.pose.pose.orientation.y,
            self.odom_global.pose.pose.orientation.z,
            self.odom_global.pose.pose.orientation.w,
        )
        course_debug = dict(self.course_debug) if self.course_debug else {}

        map_base_xy = (float(map_base_x), float(map_base_y))
        odom_global_xy = (
            float(self.odom_global.pose.pose.position.x),
            float(self.odom_global.pose.pose.position.y),
        )
        odom_gps_map_xy = (float(odom_gps_map_x), float(odom_gps_map_y))

        return {
            "phase": phase,
            "t_rel_s": float(t_rel_s),
            "gps_fix": {
                "lat": float(self.gps_fix.latitude),
                "lon": float(self.gps_fix.longitude),
                "stamp_s": _stamp_to_seconds(self.gps_fix.header.stamp),
            },
            "map_odom": {
                "x": float(map_odom_x),
                "y": float(map_odom_y),
                "yaw_deg": float(map_odom_yaw_deg),
            },
            "map_base": {
                "x": float(map_base_x),
                "y": float(map_base_y),
                "yaw_deg": float(map_base_yaw_deg),
                "lateral_error_m": float(
                    _line_lateral_error_m(map_base_xy, line_start_xy, line_end_xy)
                ),
            },
            "odom_local": {
                "x": float(self.odom_local.pose.pose.position.x),
                "y": float(self.odom_local.pose.pose.position.y),
                "yaw_deg": float(odom_local_yaw_deg),
                "vx_mps": float(self.odom_local.twist.twist.linear.x),
                "vy_mps": float(self.odom_local.twist.twist.linear.y),
                "yaw_rate_rps": float(self.odom_local.twist.twist.angular.z),
            },
            "odom_gps": {
                "x_odom": float(self.odom_gps.pose.pose.position.x),
                "y_odom": float(self.odom_gps.pose.pose.position.y),
                "x_map": float(odom_gps_map_x),
                "y_map": float(odom_gps_map_y),
                "lateral_error_m": float(
                    _line_lateral_error_m(odom_gps_map_xy, line_start_xy, line_end_xy)
                ),
            },
            "odom_global": {
                "x": float(self.odom_global.pose.pose.position.x),
                "y": float(self.odom_global.pose.pose.position.y),
                "yaw_deg": float(odom_global_yaw_deg),
                "vx_mps": float(self.odom_global.twist.twist.linear.x),
                "vy_mps": float(self.odom_global.twist.twist.linear.y),
                "yaw_rate_rps": float(self.odom_global.twist.twist.angular.z),
                "lateral_error_m": float(
                    _line_lateral_error_m(odom_global_xy, line_start_xy, line_end_xy)
                ),
            },
            "global_vs_gps_map_delta_m": float(_distance_xy(odom_global_xy, odom_gps_map_xy)),
            "global_vs_tf_map_base_delta_m": float(_distance_xy(odom_global_xy, map_base_xy)),
            "heading_debug": {
                "valid": bool(course_debug.get("valid", False)),
                "reason": str(course_debug.get("reason", "")),
                "yaw_deg": course_debug.get("yaw_deg"),
                "distance_m": course_debug.get("distance_m"),
                "speed_mps": course_debug.get("speed_mps"),
                "steer_deg": course_debug.get("steer_deg"),
                "yaw_rate_rps": course_debug.get("yaw_rate_rps"),
            },
            "drive": {
                "fresh": bool(self.drive_telemetry.fresh),
                "speed_mps_measured": float(self.drive_telemetry.speed_mps_measured),
                "steer_deg_measured": float(self.drive_telemetry.steer_deg_measured),
                "speed_valid": bool(self.drive_telemetry.speed_valid),
                "steer_valid": bool(self.drive_telemetry.steer_valid),
            },
            "latest_terminal_event_code": (
                self.latest_terminal_event()["code"] if self.latest_terminal_event() else ""
            ),
        }


def _phase_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    map_odom_y = [float(sample["map_odom"]["y"]) for sample in samples]
    map_odom_yaw = AngleSeries()
    map_base_lateral = [float(sample["map_base"]["lateral_error_m"]) for sample in samples]
    odom_gps_lateral = [float(sample["odom_gps"]["lateral_error_m"]) for sample in samples]
    odom_global_lateral = [float(sample["odom_global"]["lateral_error_m"]) for sample in samples]
    odom_global_vy = [float(sample["odom_global"]["vy_mps"]) for sample in samples]
    global_vs_gps_delta = [float(sample["global_vs_gps_map_delta_m"]) for sample in samples]
    heading_valid_count = 0
    heading_reasons: Counter[str] = Counter()
    heading_yaw = AngleSeries()

    for sample in samples:
        map_odom_yaw.add(float(sample["map_odom"]["yaw_deg"]))
        heading = sample["heading_debug"]
        heading_reasons[str(heading["reason"] or "")] += 1
        if bool(heading["valid"]):
            heading_valid_count += 1
            if heading.get("yaw_deg") is not None:
                heading_yaw.add(float(heading["yaw_deg"]))

    return {
        "sample_count": len(samples),
        "t_rel_s": {
            "start": float(samples[0]["t_rel_s"]),
            "end": float(samples[-1]["t_rel_s"]),
            "duration": float(samples[-1]["t_rel_s"] - samples[0]["t_rel_s"]),
        },
        "map_odom": {
            "y_mean_m": _mean(map_odom_y),
            "y_std_m": _std(map_odom_y),
            "y_span_m": _span(map_odom_y),
            "yaw": map_odom_yaw.summary(),
        },
        "map_base_lateral_error_m": {
            "mean": _mean(map_base_lateral),
            "std": _std(map_base_lateral),
            "span": _span(map_base_lateral),
            "max_abs": max(abs(value) for value in map_base_lateral) if map_base_lateral else None,
        },
        "odom_gps_lateral_error_m": {
            "mean": _mean(odom_gps_lateral),
            "std": _std(odom_gps_lateral),
            "span": _span(odom_gps_lateral),
            "max_abs": max(abs(value) for value in odom_gps_lateral) if odom_gps_lateral else None,
        },
        "odom_global_lateral_error_m": {
            "mean": _mean(odom_global_lateral),
            "std": _std(odom_global_lateral),
            "span": _span(odom_global_lateral),
            "max_abs": max(abs(value) for value in odom_global_lateral) if odom_global_lateral else None,
        },
        "odom_global_vy_mps": {
            "mean": _mean(odom_global_vy),
            "std": _std(odom_global_vy),
            "max_abs": max(abs(value) for value in odom_global_vy) if odom_global_vy else None,
        },
        "global_vs_gps_map_delta_m": {
            "mean": _mean(global_vs_gps_delta),
            "std": _std(global_vs_gps_delta),
            "span": _span(global_vs_gps_delta),
            "max": max(global_vs_gps_delta) if global_vs_gps_delta else None,
        },
        "gps_course_heading": {
            "valid_ratio": float(heading_valid_count) / float(len(samples)) if samples else 0.0,
            "valid_count": int(heading_valid_count),
            "invalid_count": int(len(samples) - heading_valid_count),
            "reasons": dict(sorted(heading_reasons.items())),
            "yaw": heading_yaw.summary(),
        },
    }


def _overall_summary(
    *,
    pre_samples: list[dict[str, Any]],
    run_samples: list[dict[str, Any]],
    post_samples: list[dict[str, Any]],
) -> dict[str, Any]:
    all_samples = list(pre_samples) + list(run_samples) + list(post_samples)
    global_yaw_error = AngleSeries()
    local_yaw_error = AngleSeries()
    gps_heading_yaw_error = AngleSeries()
    for sample in all_samples:
        global_yaw_error.add(float(sample["odom_global"]["yaw_deg"]))
        local_yaw_error.add(float(sample["odom_local"]["yaw_deg"]))
        heading = sample["heading_debug"]
        if bool(heading["valid"]) and heading.get("yaw_deg") is not None:
            gps_heading_yaw_error.add(float(heading["yaw_deg"]))

    return {
        "phases": {
            "pre_idle": _phase_summary(pre_samples) if pre_samples else {},
            "run": _phase_summary(run_samples) if run_samples else {},
            "post_idle": _phase_summary(post_samples) if post_samples else {},
        },
        "east_alignment_deg": {
            "odom_local": local_yaw_error.summary(),
            "odom_global": global_yaw_error.summary(),
            "gps_course_heading": gps_heading_yaw_error.summary(),
        },
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark a long straight-line run on sim_global_v2."
    )
    parser.add_argument("--goal-east-m", type=float, default=18.0)
    parser.add_argument("--goal-north-m", type=float, default=0.0)
    parser.add_argument("--goal-yaw-deg", type=float, default=float("nan"))
    parser.add_argument("--pre-idle-s", type=float, default=4.0)
    parser.add_argument("--post-idle-s", type=float, default=12.0)
    parser.add_argument("--timeout-s", type=float, default=90.0)
    parser.add_argument("--sample-hz", type=float, default=5.0)
    parser.add_argument("--output", default="")
    parser.add_argument("--keep-samples", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    rclpy.init()
    node = StraightBenchmarkNode()
    try:
        if not node.wait_for_bootstrap():
            raise RuntimeError("sim_global_v2 runtime not ready")

        start_fix = node.gps_fix
        if start_fix is None:
            raise RuntimeError("missing /gps/fix")
        start_map_base = node._map_base_from_local()
        goal_lat, goal_lon = _offset_lat_lon(
            float(start_fix.latitude),
            float(start_fix.longitude),
            north_m=float(args.goal_north_m),
            east_m=float(args.goal_east_m),
        )
        goal_yaw_deg = (
            float(args.goal_yaw_deg)
            if math.isfinite(float(args.goal_yaw_deg))
            else ros_yaw_deg_from_north_east(float(args.goal_north_m), float(args.goal_east_m))
        )
        goal_projection = node.fromll_to_map(goal_lat, goal_lon)
        line_start_xy = (float(start_map_base[0]), float(start_map_base[1]))
        line_end_xy = (
            float(goal_projection["map_xy"][0]),
            float(goal_projection["map_xy"][1]),
        )

        pre_samples: list[dict[str, Any]] = []
        run_samples: list[dict[str, Any]] = []
        post_samples: list[dict[str, Any]] = []
        sample_period_s = 1.0 / max(1.0, float(args.sample_hz))
        bench_start_monotonic = time.time()

        def sample_phase(
            phase_name: str,
            phase_duration_s: float,
            collector: list[dict[str, Any]],
        ) -> None:
            end = time.time() + max(0.0, float(phase_duration_s))
            while time.time() < end:
                rclpy.spin_once(node, timeout_sec=0.05)
                snapshot = node.sample_snapshot(
                    phase=phase_name,
                    t_rel_s=time.time() - bench_start_monotonic,
                    line_start_xy=line_start_xy,
                    line_end_xy=line_end_xy,
                )
                if snapshot is not None:
                    collector.append(snapshot)
                time.sleep(sample_period_s)

        sample_phase("pre_idle", float(args.pre_idle_s), pre_samples)

        service_response = node.send_goal(goal_lat, goal_lon, goal_yaw_deg)
        if not service_response["ok"]:
            raise RuntimeError(f"set_goal_ll failed: {service_response['error']}")

        terminal_event: Optional[dict[str, Any]] = None
        run_end = time.time() + float(args.timeout_s)
        while time.time() < run_end:
            rclpy.spin_once(node, timeout_sec=0.05)
            snapshot = node.sample_snapshot(
                phase="run",
                t_rel_s=time.time() - bench_start_monotonic,
                line_start_xy=line_start_xy,
                line_end_xy=line_end_xy,
            )
            if snapshot is not None:
                run_samples.append(snapshot)
            terminal_event = node.latest_terminal_event()
            if terminal_event is not None:
                break
            time.sleep(sample_period_s)

        sample_phase("post_idle", float(args.post_idle_s), post_samples)

        final_map_base = node._map_base_from_local()
        goal_map_xy = (
            float(goal_projection["map_xy"][0]),
            float(goal_projection["map_xy"][1]),
        )
        payload = {
            "goal": {
                "start_fix_lat": float(start_fix.latitude),
                "start_fix_lon": float(start_fix.longitude),
                "goal_lat": float(goal_lat),
                "goal_lon": float(goal_lon),
                "goal_yaw_deg": float(goal_yaw_deg),
                "goal_offset_north_m": float(args.goal_north_m),
                "goal_offset_east_m": float(args.goal_east_m),
                "start_map_base_xy": [float(start_map_base[0]), float(start_map_base[1])],
                "goal_map_xy": [float(goal_map_xy[0]), float(goal_map_xy[1])],
                "final_map_base_xy": [float(final_map_base[0]), float(final_map_base[1])],
                "distance_start_to_goal_m": float(_distance_xy(line_start_xy, goal_map_xy)),
                "distance_final_to_goal_m": float(
                    _distance_xy((float(final_map_base[0]), float(final_map_base[1])), goal_map_xy)
                ),
            },
            "service_response": service_response,
            "terminal_event": terminal_event or {},
            "summary": _overall_summary(
                pre_samples=pre_samples,
                run_samples=run_samples,
                post_samples=post_samples,
            ),
            "event_tail": node.events[-20:],
        }
        if args.keep_samples:
            payload["samples"] = {
                "pre_idle": pre_samples,
                "run": run_samples,
                "post_idle": post_samples,
            }

        rendered = json.dumps(_json_ready(payload), indent=2, sort_keys=True)
        print(rendered)
        if args.output:
            Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
import math
from pathlib import Path
import time
from typing import Any, Optional

from geographic_msgs.msg import GeoPoint
from interfaces.msg import DriveTelemetry, NavEvent, NavTelemetry
from interfaces.srv import CancelNavGoal, SetNavGoalLL
from nav_msgs.msg import Odometry
import rclpy
from rclpy.node import Node
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix
from std_msgs.msg import String
import tf2_geometry_msgs  # noqa: F401
from tf2_msgs.msg import TFMessage

from navegacion_gps.heading_math import yaw_deg_from_quaternion_xyzw
from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.nav_benchmarking import BenchmarkScenario
from navegacion_gps.nav_benchmarking import DEFAULT_JUMP_THRESHOLD_DEG
from navegacion_gps.nav_benchmarking import body_relative_offsets_to_north_east
from navegacion_gps.nav_benchmarking import default_benchmark_catalog_path
from navegacion_gps.nav_benchmarking import distance_xy
from navegacion_gps.nav_benchmarking import event_code_counts
from navegacion_gps.nav_benchmarking import json_ready
from navegacion_gps.nav_benchmarking import line_lateral_error_m
from navegacion_gps.nav_benchmarking import line_progress_m
from navegacion_gps.nav_benchmarking import load_benchmark_catalog
from navegacion_gps.nav_benchmarking import offset_lat_lon
from navegacion_gps.nav_benchmarking import resolve_goal_yaw_deg
from navegacion_gps.nav_benchmarking import select_benchmark_scenarios
from navegacion_gps.nav_benchmarking import summarize_angle
from navegacion_gps.nav_benchmarking import summarize_angle_jumps
from navegacion_gps.nav_benchmarking import summarize_scalar


TERMINAL_EVENT_CODES = {
    "GOAL_COMPLETED",
    "GOAL_FAILED",
    "GOAL_REJECTED",
    "GOAL_RESULT_SUCCEEDED",
    "GOAL_RESULT_ABORTED",
}


def _stamp_to_seconds(stamp) -> float:
    return float(stamp.sec) + float(stamp.nanosec) / 1_000_000_000.0


def _path_distance(points_xy: list[tuple[float, float]]) -> float:
    return sum(
        distance_xy(prev_point, point)
        for prev_point, point in zip(points_xy[:-1], points_xy[1:])
    )


def _scenario_to_dict(scenario: BenchmarkScenario) -> dict[str, Any]:
    return {
        "id": scenario.scenario_id,
        "type": scenario.scenario_type,
        "order": scenario.order,
        "difficulty": scenario.difficulty,
        "description": scenario.description,
        "purpose": scenario.purpose,
        "tags": list(scenario.tags),
        "pre_idle_s": scenario.pre_idle_s,
        "post_idle_s": scenario.post_idle_s,
        "run_timeout_s": scenario.run_timeout_s,
        "sample_hz": scenario.sample_hz,
        "hold_s": scenario.hold_s,
        "forward_m": scenario.forward_m,
        "left_m": scenario.left_m,
        "north_m": scenario.north_m,
        "east_m": scenario.east_m,
        "yaw_mode": scenario.yaw_mode,
        "yaw_deg": scenario.yaw_deg,
        "yaw_delta_deg": scenario.yaw_delta_deg,
    }


class NavBenchmarkRunnerNode(Node):
    def __init__(self) -> None:
        super().__init__("nav_benchmark_runner")

        self.gps_fix: Optional[NavSatFix] = None
        self.odom_local: Optional[Odometry] = None
        self.odom_gps: Optional[Odometry] = None
        self.odom_global: Optional[Odometry] = None
        self.drive_telemetry: Optional[DriveTelemetry] = None
        self.nav_telemetry: Optional[NavTelemetry] = None
        self.course_debug: dict[str, Any] = {}
        self.events: list[dict[str, Any]] = []
        self.latest_map_odom_tf: Optional[dict[str, float]] = None

        self.create_subscription(NavSatFix, "/gps/fix", self._on_gps_fix, 10)
        self.create_subscription(Odometry, "/odometry/local", self._on_odom_local, 10)
        self.create_subscription(Odometry, "/odometry/gps", self._on_odom_gps, 10)
        self.create_subscription(Odometry, "/odometry/global", self._on_odom_global, 10)
        self.create_subscription(
            DriveTelemetry,
            "/controller/drive_telemetry",
            self._on_drive_telemetry,
            10,
        )
        self.create_subscription(
            NavTelemetry,
            "/nav_command_server/telemetry",
            self._on_nav_telemetry,
            10,
        )
        self.create_subscription(String, "/gps/course_heading/debug", self._on_course_debug, 50)
        self.create_subscription(NavEvent, "/nav_command_server/events", self._on_nav_event, 100)
        self.create_subscription(TFMessage, "/tf", self._on_tf, 100)

        self.fromll_client = self.create_client(FromLL, "/fromLL")
        self.goal_client = self.create_client(SetNavGoalLL, "/nav_command_server/set_goal_ll")
        self.cancel_goal_client = self.create_client(
            CancelNavGoal, "/nav_command_server/cancel_goal"
        )

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        self.gps_fix = msg

    def _on_odom_local(self, msg: Odometry) -> None:
        self.odom_local = msg

    def _on_odom_gps(self, msg: Odometry) -> None:
        self.odom_gps = msg

    def _on_odom_global(self, msg: Odometry) -> None:
        self.odom_global = msg

    def _on_drive_telemetry(self, msg: DriveTelemetry) -> None:
        self.drive_telemetry = msg

    def _on_nav_telemetry(self, msg: NavTelemetry) -> None:
        self.nav_telemetry = msg

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

    def wait_for_bootstrap(self, timeout_s: float) -> bool:
        if not self.fromll_client.wait_for_service(timeout_sec=timeout_s):
            return False
        if not self.goal_client.wait_for_service(timeout_sec=timeout_s):
            return False
        if not self.cancel_goal_client.wait_for_service(timeout_sec=timeout_s):
            return False
        return self.spin_until(
            lambda: self.gps_fix is not None
            and self.odom_local is not None
            and self.odom_gps is not None
            and self.odom_global is not None
            and self.drive_telemetry is not None
            and self.nav_telemetry is not None
            and self.latest_map_odom_tf is not None,
            timeout_s=timeout_s,
        )

    def wait_for_idle(self, timeout_s: float) -> bool:
        def _is_idle() -> bool:
            if self.nav_telemetry is None:
                return False
            return (not bool(self.nav_telemetry.goal_active)) and (
                not bool(self.nav_telemetry.manual_enabled)
            )

        return self.spin_until(_is_idle, timeout_s=timeout_s)

    def latest_terminal_event_since(
        self, start_index: int
    ) -> Optional[dict[str, Any]]:
        for event in reversed(self.events[start_index:]):
            if event["code"] in TERMINAL_EVENT_CODES:
                return event
        return None

    def _map_odom_pose(self) -> tuple[float, float, float]:
        if self.latest_map_odom_tf is None:
            raise RuntimeError("missing map->odom tf")
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

    def map_base_pose(self) -> tuple[float, float, float]:
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

    def send_goal(
        self,
        *,
        lat: float,
        lon: float,
        yaw_deg: float,
        timeout_s: float = 10.0,
    ) -> dict[str, Any]:
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

    def cancel_goal(self, timeout_s: float = 10.0) -> dict[str, Any]:
        future = self.cancel_goal_client.call_async(CancelNavGoal.Request())
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                response = future.result()
                return {"ok": bool(response.ok), "error": str(response.error)}
        raise RuntimeError("timeout waiting for /nav_command_server/cancel_goal response")

    def sample_snapshot(
        self,
        *,
        phase: str,
        t_rel_s: float,
        line_start_xy: tuple[float, float],
        line_end_xy: tuple[float, float],
        goal_map_xy: tuple[float, float],
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
            map_base_x, map_base_y, map_base_yaw_deg = self.map_base_pose()
            odom_gps_map_x, odom_gps_map_y = self._transform_odom_xy_to_map(
                float(self.odom_gps.pose.pose.position.x),
                float(self.odom_gps.pose.pose.position.y),
            )
        except Exception:
            return None

        course_debug = dict(self.course_debug) if self.course_debug else {}
        nav_telemetry = self.nav_telemetry

        map_base_xy = (float(map_base_x), float(map_base_y))
        odom_local_yaw_deg = float(
            yaw_deg_from_quaternion_xyzw(
                self.odom_local.pose.pose.orientation.x,
                self.odom_local.pose.pose.orientation.y,
                self.odom_local.pose.pose.orientation.z,
                self.odom_local.pose.pose.orientation.w,
            )
        )
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
                    line_lateral_error_m(map_base_xy, line_start_xy, line_end_xy)
                ),
                "progress_m": float(line_progress_m(map_base_xy, line_start_xy, line_end_xy)),
                "goal_distance_m": float(distance_xy(map_base_xy, goal_map_xy)),
            },
            "odom_local": {
                "x": float(self.odom_local.pose.pose.position.x),
                "y": float(self.odom_local.pose.pose.position.y),
                "yaw_deg": odom_local_yaw_deg,
                "vx_mps": float(self.odom_local.twist.twist.linear.x),
                "vy_mps": float(self.odom_local.twist.twist.linear.y),
                "yaw_rate_rps": float(self.odom_local.twist.twist.angular.z),
                "stamp_s": _stamp_to_seconds(self.odom_local.header.stamp),
            },
            "odom_gps": {
                "x_odom": float(self.odom_gps.pose.pose.position.x),
                "y_odom": float(self.odom_gps.pose.pose.position.y),
                "x_map": float(odom_gps_map_x),
                "y_map": float(odom_gps_map_y),
                "lateral_error_m": float(
                    line_lateral_error_m(odom_gps_map_xy, line_start_xy, line_end_xy)
                ),
            },
            "odom_global": {
                "x": float(self.odom_global.pose.pose.position.x),
                "y": float(self.odom_global.pose.pose.position.y),
                "yaw_deg": float(
                    yaw_deg_from_quaternion_xyzw(
                        self.odom_global.pose.pose.orientation.x,
                        self.odom_global.pose.pose.orientation.y,
                        self.odom_global.pose.pose.orientation.z,
                        self.odom_global.pose.pose.orientation.w,
                    )
                ),
                "vx_mps": float(self.odom_global.twist.twist.linear.x),
                "vy_mps": float(self.odom_global.twist.twist.linear.y),
                "yaw_rate_rps": float(self.odom_global.twist.twist.angular.z),
                "stamp_s": _stamp_to_seconds(self.odom_global.header.stamp),
                "lateral_error_m": float(
                    line_lateral_error_m(odom_global_xy, line_start_xy, line_end_xy)
                ),
            },
            "drive": {
                "fresh": bool(self.drive_telemetry.fresh),
                "ready": bool(self.drive_telemetry.ready),
                "estop": bool(self.drive_telemetry.estop),
                "control_source": str(self.drive_telemetry.control_source),
                "speed_mps_measured": float(self.drive_telemetry.speed_mps_measured),
                "steer_deg_measured": float(self.drive_telemetry.steer_deg_measured),
                "speed_valid": bool(self.drive_telemetry.speed_valid),
                "steer_valid": bool(self.drive_telemetry.steer_valid),
            },
            "nav_telemetry": {
                "goal_active": bool(nav_telemetry.goal_active) if nav_telemetry else False,
                "manual_enabled": (
                    bool(nav_telemetry.manual_enabled) if nav_telemetry else False
                ),
                "auto_mode": str(nav_telemetry.auto_mode) if nav_telemetry else "",
                "active_action": str(nav_telemetry.active_action) if nav_telemetry else "",
                "collision_stop_active": (
                    bool(nav_telemetry.collision_stop_active) if nav_telemetry else False
                ),
                "failure_code": str(nav_telemetry.failure_code) if nav_telemetry else "",
                "failure_component": (
                    str(nav_telemetry.failure_component) if nav_telemetry else ""
                ),
            },
            "heading_debug": {
                "valid": bool(course_debug.get("valid", False)),
                "reason": str(course_debug.get("reason", "")),
                "yaw_deg": course_debug.get("yaw_deg"),
                "distance_m": course_debug.get("distance_m"),
                "speed_mps": course_debug.get("speed_mps"),
                "steer_deg": course_debug.get("steer_deg"),
                "yaw_rate_rps": course_debug.get("yaw_rate_rps"),
                "latest_fix_age_s": course_debug.get("latest_fix_age_s"),
                "sample_dt_s": course_debug.get("sample_dt_s"),
            },
        }


def _build_run_summary(
    *,
    scenario: BenchmarkScenario,
    pre_samples: list[dict[str, Any]],
    run_samples: list[dict[str, Any]],
    post_samples: list[dict[str, Any]],
    scenario_events: list[dict[str, Any]],
    terminal_event: dict[str, Any],
    timed_out: bool,
    goal_distance_m: float,
    final_goal_error_m: float,
    jump_threshold_deg: float,
) -> dict[str, Any]:
    all_samples = list(pre_samples) + list(run_samples) + list(post_samples)
    map_odom_yaws = [float(sample["map_odom"]["yaw_deg"]) for sample in all_samples]
    map_base_yaws = [float(sample["map_base"]["yaw_deg"]) for sample in all_samples]
    odom_local_yaws = [float(sample["odom_local"]["yaw_deg"]) for sample in all_samples]
    map_base_lateral = [float(sample["map_base"]["lateral_error_m"]) for sample in run_samples]
    odom_global_lateral = [
        float(sample["odom_global"]["lateral_error_m"]) for sample in run_samples
    ]
    progress_values = [float(sample["map_base"]["progress_m"]) for sample in run_samples]
    goal_distance_values = [
        float(sample["map_base"]["goal_distance_m"]) for sample in run_samples
    ]
    drive_speeds = [float(sample["drive"]["speed_mps_measured"]) for sample in all_samples]
    map_points = [
        (float(sample["map_base"]["x"]), float(sample["map_base"]["y"])) for sample in all_samples
    ]
    heading_valid_count = sum(
        1 for sample in run_samples if bool(sample["heading_debug"]["valid"])
    )
    heading_reasons = Counter(
        str(sample["heading_debug"]["reason"] or "") for sample in run_samples
    )
    gps_heading_yaws = [
        float(sample["heading_debug"]["yaw_deg"])
        for sample in run_samples
        if bool(sample["heading_debug"]["valid"])
        and sample["heading_debug"]["yaw_deg"] is not None
    ]
    success = terminal_event.get("code") in {"GOAL_COMPLETED", "GOAL_RESULT_SUCCEEDED", "HOLD_COMPLETED"}
    run_duration_s = float(run_samples[-1]["t_rel_s"] - run_samples[0]["t_rel_s"]) if len(run_samples) >= 2 else 0.0
    total_duration_s = float(all_samples[-1]["t_rel_s"] - all_samples[0]["t_rel_s"]) if len(all_samples) >= 2 else 0.0
    goal_progress_final = progress_values[-1] if progress_values else 0.0
    goal_progress_ratio = (
        float(goal_progress_final) / float(goal_distance_m)
        if goal_distance_m > 1.0e-6
        else None
    )

    return {
        "scenario_type": scenario.scenario_type,
        "sample_count": len(all_samples),
        "outcome": {
            "success": bool(success),
            "timeout": bool(timed_out),
            "terminal_event_code": str(terminal_event.get("code", "")),
            "terminal_event_message": str(terminal_event.get("message", "")),
            "duration_s": float(total_duration_s),
            "run_duration_s": float(run_duration_s),
            "goal_distance_m": float(goal_distance_m),
            "final_goal_error_m": float(final_goal_error_m),
        },
        "path_tracking": {
            "map_base_lateral_error_m": {
                "signed": summarize_scalar(map_base_lateral),
                "absolute": summarize_scalar(abs(value) for value in map_base_lateral),
            },
            "odom_global_lateral_error_m": {
                "signed": summarize_scalar(odom_global_lateral),
                "absolute": summarize_scalar(abs(value) for value in odom_global_lateral),
            },
            "goal_distance_m": summarize_scalar(goal_distance_values),
            "progress": {
                "final_m": float(goal_progress_final),
                "max_m": max(progress_values) if progress_values else None,
                "ratio": goal_progress_ratio,
            },
        },
        "heading_stability": {
            "map_odom_yaw": {
                **summarize_angle(map_odom_yaws),
                "jumps": summarize_angle_jumps(
                    map_odom_yaws,
                    jump_threshold_deg=jump_threshold_deg,
                ),
            },
            "map_base_yaw": {
                **summarize_angle(map_base_yaws),
                "jumps": summarize_angle_jumps(
                    map_base_yaws,
                    jump_threshold_deg=jump_threshold_deg,
                ),
            },
            "odom_local_yaw": {
                **summarize_angle(odom_local_yaws),
                "jumps": summarize_angle_jumps(
                    odom_local_yaws,
                    jump_threshold_deg=jump_threshold_deg,
                ),
            },
            "gps_course_heading": {
                "valid_ratio": (
                    float(heading_valid_count) / float(len(run_samples)) if run_samples else 0.0
                ),
                "valid_count": int(heading_valid_count),
                "invalid_count": int(len(run_samples) - heading_valid_count),
                "reasons": dict(sorted(heading_reasons.items())),
                "yaw": summarize_angle(gps_heading_yaws),
            },
        },
        "motion": {
            "map_distance_travelled_m": float(_path_distance(map_points)),
            "drive_speed_mps": summarize_scalar(drive_speeds),
        },
        "events": {"counts": event_code_counts(scenario_events)},
    }


def _aggregate_session(runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not runs:
        return {
            "scenario_count": 0,
            "success_count": 0,
            "timeout_count": 0,
            "terminal_event_codes": {},
        }
    terminal_events = Counter(str(run["summary"]["outcome"]["terminal_event_code"]) for run in runs)
    final_errors = [float(run["summary"]["outcome"]["final_goal_error_m"]) for run in runs]
    map_odom_jump_max = [
        float(run["summary"]["heading_stability"]["map_odom_yaw"]["jumps"]["max"] or 0.0)
        for run in runs
    ]
    return {
        "scenario_count": len(runs),
        "success_count": sum(1 for run in runs if bool(run["summary"]["outcome"]["success"])),
        "timeout_count": sum(1 for run in runs if bool(run["summary"]["outcome"]["timeout"])),
        "terminal_event_codes": dict(sorted(terminal_events.items())),
        "final_goal_error_m": summarize_scalar(final_errors),
        "map_odom_jump_max_abs_deg": summarize_scalar(map_odom_jump_max),
    }


def _list_catalog(catalog_path: Path) -> None:
    catalog = load_benchmark_catalog(catalog_path)
    print(f"Catalogo: {catalog_path}")
    print(f"Default profile: {catalog.default_profile or 'N/A'}")
    print("Profiles:")
    for profile_id, profile in sorted(catalog.profiles.items()):
        print(
            f"  - {profile_id}: {profile.description or 'sin descripcion'} "
            f"({len(profile.scenario_ids)} escenarios)"
        )
    print("Scenarios:")
    for scenario in sorted(
        catalog.scenarios.values(),
        key=lambda item: (item.order, item.difficulty, item.scenario_id),
    ):
        print(
            f"  - {scenario.scenario_id}: diff={scenario.difficulty} "
            f"type={scenario.scenario_type} "
            f"desc='{scenario.description}'"
        )
        print(f"    purpose={scenario.purpose or 'N/A'}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a graded navigation benchmark suite against the active runtime."
    )
    parser.add_argument("--catalog", default=str(default_benchmark_catalog_path()))
    parser.add_argument("--profile", default="")
    parser.add_argument("--scenarios", default="")
    parser.add_argument("--max-difficulty", type=int, default=None)
    parser.add_argument("--output", default="")
    parser.add_argument("--keep-samples", action="store_true")
    parser.add_argument("--bootstrap-timeout-s", type=float, default=45.0)
    parser.add_argument("--idle-timeout-s", type=float, default=20.0)
    parser.add_argument("--jump-threshold-deg", type=float, default=DEFAULT_JUMP_THRESHOLD_DEG)
    parser.add_argument("--list", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    catalog_path = Path(args.catalog)
    if args.list:
        _list_catalog(catalog_path)
        return

    catalog = load_benchmark_catalog(catalog_path)
    scenario_ids = [item.strip() for item in str(args.scenarios).split(",") if item.strip()]
    scenarios = select_benchmark_scenarios(
        catalog,
        profile=str(args.profile),
        scenario_ids=scenario_ids or None,
        max_difficulty=args.max_difficulty,
    )
    if not scenarios:
        raise RuntimeError("No benchmark scenarios selected")

    rclpy.init()
    node = NavBenchmarkRunnerNode()
    try:
        if not node.wait_for_bootstrap(timeout_s=float(args.bootstrap_timeout_s)):
            raise RuntimeError("runtime not ready for benchmark bootstrap")
        if not node.wait_for_idle(timeout_s=float(args.idle_timeout_s)):
            raise RuntimeError(
                "runtime is not idle; verify no active goal and manual mode disabled"
            )

        runs: list[dict[str, Any]] = []
        for scenario in scenarios:
            node.get_logger().info(f"Running benchmark scenario '{scenario.scenario_id}'")
            if not node.wait_for_idle(timeout_s=float(args.idle_timeout_s)):
                raise RuntimeError(
                    f"runtime did not return to idle before scenario '{scenario.scenario_id}'"
                )

            start_fix = node.gps_fix
            if start_fix is None:
                raise RuntimeError("missing /gps/fix")
            start_map_base = node.map_base_pose()
            start_map_xy = (float(start_map_base[0]), float(start_map_base[1]))
            start_yaw_deg = float(start_map_base[2])

            north_m = float(scenario.north_m)
            east_m = float(scenario.east_m)
            if scenario.scenario_type == "body_relative_goal":
                north_m, east_m = body_relative_offsets_to_north_east(
                    start_yaw_deg=start_yaw_deg,
                    forward_m=scenario.forward_m,
                    left_m=scenario.left_m,
                )

            goal_info: dict[str, Any] = {
                "start_fix_lat": float(start_fix.latitude),
                "start_fix_lon": float(start_fix.longitude),
                "start_map_base_xy": [float(start_map_base[0]), float(start_map_base[1])],
                "start_map_base_yaw_deg": float(start_yaw_deg),
                "offset_north_m": float(north_m),
                "offset_east_m": float(east_m),
                "goal_lat": None,
                "goal_lon": None,
                "goal_yaw_deg": None,
                "goal_map_xy": [float(start_map_xy[0]), float(start_map_xy[1])],
            }
            goal_map_xy = start_map_xy
            line_end_xy = start_map_xy
            service_response = {"ok": True, "error": ""}

            if scenario.scenario_type != "hold":
                goal_lat, goal_lon = offset_lat_lon(
                    float(start_fix.latitude),
                    float(start_fix.longitude),
                    north_m=north_m,
                    east_m=east_m,
                )
                goal_yaw_deg = resolve_goal_yaw_deg(
                    scenario,
                    start_yaw_deg=start_yaw_deg,
                    north_m=north_m,
                    east_m=east_m,
                )
                projection_mode = "fromll"
                try:
                    goal_projection = node.fromll_to_map(goal_lat, goal_lon)
                    goal_map_xy = (
                        float(goal_projection["map_xy"][0]),
                        float(goal_projection["map_xy"][1]),
                    )
                except RuntimeError as exc:
                    projection_mode = "approx_start_map_plus_offset"
                    node.get_logger().warning(
                        f"/fromLL timeout for scenario '{scenario.scenario_id}', "
                        f"using approximate map goal projection ({exc})"
                    )
                    goal_map_xy = (
                        float(start_map_xy[0]) + float(east_m),
                        float(start_map_xy[1]) + float(north_m),
                    )
                line_end_xy = goal_map_xy
                goal_info.update(
                    {
                        "goal_lat": float(goal_lat),
                        "goal_lon": float(goal_lon),
                        "goal_yaw_deg": float(goal_yaw_deg),
                        "goal_map_xy": [float(goal_map_xy[0]), float(goal_map_xy[1])],
                        "goal_projection_mode": projection_mode,
                    }
                )

            goal_distance_m = float(distance_xy(start_map_xy, line_end_xy))
            pre_samples: list[dict[str, Any]] = []
            run_samples: list[dict[str, Any]] = []
            post_samples: list[dict[str, Any]] = []
            sample_period_s = 1.0 / max(1.0, float(scenario.sample_hz))
            scenario_start_mono = time.time()

            def _append_snapshot(phase_name: str, collector: list[dict[str, Any]]) -> None:
                snapshot = node.sample_snapshot(
                    phase=phase_name,
                    t_rel_s=time.time() - scenario_start_mono,
                    line_start_xy=start_map_xy,
                    line_end_xy=line_end_xy,
                    goal_map_xy=goal_map_xy,
                )
                if snapshot is not None:
                    collector.append(snapshot)

            def _sample_phase(
                phase_name: str,
                duration_s: float,
                collector: list[dict[str, Any]],
            ) -> None:
                duration_s = max(0.0, float(duration_s))
                if duration_s <= 0.0:
                    return
                end = time.time() + duration_s
                next_sample_at = time.time()
                while time.time() < end:
                    now = time.time()
                    timeout_sec = min(0.02, max(0.0, next_sample_at - now))
                    rclpy.spin_once(node, timeout_sec=timeout_sec)
                    now = time.time()
                    while now >= next_sample_at and next_sample_at < end:
                        _append_snapshot(phase_name, collector)
                        next_sample_at += sample_period_s
                _append_snapshot(phase_name, collector)

            _sample_phase("pre_idle", float(scenario.pre_idle_s), pre_samples)

            event_start_index = len(node.events)
            timed_out = False
            terminal_event: dict[str, Any] = {}
            if scenario.scenario_type == "hold":
                _sample_phase("run", float(scenario.hold_s), run_samples)
                terminal_event = {
                    "code": "HOLD_COMPLETED",
                    "message": f"hold completed ({scenario.hold_s:.1f}s)",
                }
            else:
                service_response = node.send_goal(
                    lat=float(goal_info["goal_lat"]),
                    lon=float(goal_info["goal_lon"]),
                    yaw_deg=float(goal_info["goal_yaw_deg"]),
                )
                if not service_response["ok"]:
                    raise RuntimeError(
                        f"set_goal_ll failed for '{scenario.scenario_id}': "
                        f"{service_response['error']}"
                    )

                run_end = time.time() + float(scenario.run_timeout_s)
                next_sample_at = time.time()
                while time.time() < run_end:
                    now = time.time()
                    timeout_sec = min(0.02, max(0.0, next_sample_at - now))
                    rclpy.spin_once(node, timeout_sec=timeout_sec)
                    now = time.time()
                    while now >= next_sample_at:
                        _append_snapshot("run", run_samples)
                        next_sample_at += sample_period_s
                    latest_terminal = node.latest_terminal_event_since(event_start_index)
                    if latest_terminal is not None:
                        terminal_event = latest_terminal
                        break
                if not terminal_event:
                    _append_snapshot("run", run_samples)

                if not terminal_event:
                    timed_out = True
                    cancel_response = node.cancel_goal()
                    terminal_event = {
                        "code": "TIMEOUT",
                        "message": (
                            "scenario timed out; cancel requested "
                            f"(ok={int(cancel_response['ok'])}, error='{cancel_response['error']}')"
                        ),
                    }

            _sample_phase("post_idle", float(scenario.post_idle_s), post_samples)

            final_map_base = node.map_base_pose()
            final_goal_error_m = float(
                distance_xy(
                    (float(final_map_base[0]), float(final_map_base[1])),
                    goal_map_xy,
                )
            )
            scenario_events = node.events[event_start_index:]
            run_payload = {
                "scenario": _scenario_to_dict(scenario),
                "goal": {
                    **goal_info,
                    "goal_distance_m": float(goal_distance_m),
                    "final_map_base_xy": [float(final_map_base[0]), float(final_map_base[1])],
                    "final_map_base_yaw_deg": float(final_map_base[2]),
                    "final_goal_error_m": float(final_goal_error_m),
                },
                "service_response": service_response,
                "terminal_event": terminal_event,
                "summary": _build_run_summary(
                    scenario=scenario,
                    pre_samples=pre_samples,
                    run_samples=run_samples,
                    post_samples=post_samples,
                    scenario_events=scenario_events,
                    terminal_event=terminal_event,
                    timed_out=timed_out,
                    goal_distance_m=goal_distance_m,
                    final_goal_error_m=final_goal_error_m,
                    jump_threshold_deg=float(args.jump_threshold_deg),
                ),
                "event_tail": scenario_events[-20:],
            }
            if args.keep_samples:
                run_payload["samples"] = {
                    "pre_idle": pre_samples,
                    "run": run_samples,
                    "post_idle": post_samples,
                }
            runs.append(run_payload)

        payload = {
            "tool": "nav_benchmark_runner",
            "version": 1,
            "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "catalog_path": str(catalog_path),
            "profile": str(args.profile or catalog.default_profile),
            "selected_scenarios": [scenario.scenario_id for scenario in scenarios],
            "runs": runs,
            "aggregate": _aggregate_session(runs),
        }
        rendered = json.dumps(json_ready(payload), indent=2, sort_keys=True)
        print(rendered)
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered + "\n", encoding="utf-8")
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()

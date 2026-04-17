from __future__ import annotations
"""ROS 2 node that replays waypoint files as a continuous patrol loop."""

from action_msgs.msg import GoalStatus
import json
import math
from pathlib import Path
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from interfaces.msg import NavTelemetry
from interfaces.srv import BrakeNav, CancelNavGoal, SetManualMode, SetNavGoalLL
import rclpy
from rcl_interfaces.msg import SetParametersResult
from rclpy.node import Node
from rclpy.parameter import Parameter
from std_msgs.msg import String
from std_srvs.srv import SetBool
import yaml


def _finite_float(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return out


def _compute_approach_bearing_enu(
    lat_from: float,
    lon_from: float,
    lat_to: float,
    lon_to: float,
) -> Optional[float]:
    """Return the ENU bearing (0=East, CCW positive) from point A to point B.

    Returns None when the two points are too close to compute a meaningful bearing.
    """
    dlon = math.radians(lon_to - lon_from)
    lat_from_r = math.radians(lat_from)
    lat_to_r = math.radians(lat_to)
    x = math.sin(dlon) * math.cos(lat_to_r)
    y = (
        math.cos(lat_from_r) * math.sin(lat_to_r)
        - math.sin(lat_from_r) * math.cos(lat_to_r) * math.cos(dlon)
    )
    if abs(x) < 1.0e-9 and abs(y) < 1.0e-9:
        return None
    geographic_bearing_deg = math.degrees(math.atan2(x, y))  # 0=North, CW
    return 90.0 - geographic_bearing_deg  # convert to ENU: 0=East, CCW


def load_patrol_waypoints(
    file_path: Path,
) -> Tuple[bool, str, List[Dict[str, Any]]]:
    """Load patrol waypoints while preserving optional labels and local snapshots."""
    path = Path(file_path).expanduser()
    if not path.exists():
        return False, f"waypoints file not found: {path}", []

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        return False, f"failed reading waypoints file: {exc}", []
    if not isinstance(raw, dict):
        return False, "yaml root must be a map/object", []

    waypoints_raw = raw.get("waypoints")
    if not isinstance(waypoints_raw, list) or len(waypoints_raw) == 0:
        return False, "waypoints must be a non-empty list", []

    waypoints: List[Dict[str, Any]] = []
    for index, item in enumerate(waypoints_raw):
        if not isinstance(item, dict):
            return False, f"waypoint[{index}] must be an object", []
        lat = _finite_float(item.get("lat", item.get("latitude")))
        lon = _finite_float(item.get("lon", item.get("longitude")))
        x = _finite_float(item.get("x"))
        y = _finite_float(item.get("y"))
        yaw_deg = _finite_float(item.get("yaw_deg", item.get("yaw", 0.0)))
        if yaw_deg is None:
            return False, f"invalid waypoint[{index}] yaw", []
        if lat is None or lon is None:
            if x is None or y is None:
                return False, f"waypoint[{index}] requires lat/lon or x/y", []
        waypoints.append(
            {
                "lat": lat,
                "lon": lon,
                "x": x,
                "y": y,
                "yaw_deg": float(yaw_deg),
                "label": str(item.get("label") or f"wp_{index}"),
            }
        )
    return True, "", waypoints


class LoopPatrolRunnerNode(Node):
    """Replay recorded waypoints through nav_command_server in a loop."""

    def __init__(self) -> None:
        super().__init__("loop_patrol_runner")

        self.declare_parameter("waypoints_file", "~/.ros/recorded_waypoints.yaml")
        self.declare_parameter("loop_delay_s", 1.0)
        self.declare_parameter("max_retries", 2)
        self.declare_parameter("goal_timeout_s", 120.0)
        self.declare_parameter("nav_mode", "global")
        self.declare_parameter("telemetry_topic", "/nav_command_server/telemetry")
        self.declare_parameter("set_goal_service", "/nav_command_server/set_goal_ll")
        self.declare_parameter("cancel_goal_service", "/nav_command_server/cancel_goal")
        self.declare_parameter("brake_service", "/nav_command_server/brake")
        self.declare_parameter("set_manual_mode_service", "/nav_command_server/set_manual_mode")

        self._lock = threading.Lock()
        self._active = False
        self._current_index = 0
        self._prev_wp_index = -1
        self._retry_count = 0
        self._goal_request_pending = False
        self._manual_disable_pending = False
        self._goal_in_flight = False
        self._goal_sent_monotonic: Optional[float] = None
        self._next_dispatch_monotonic: Optional[float] = None
        self._last_nav_result_status = int(GoalStatus.STATUS_UNKNOWN)
        self._last_nav_result_text = "idle"
        self._last_nav_result_event_id = 0
        self._last_handled_nav_result_event_id = 0
        self._manual_enabled = False
        self._warned_local_fallback = False

        self._waypoints_file = Path(str(self.get_parameter("waypoints_file").value)).expanduser()
        self._loop_delay_s = max(0.0, float(self.get_parameter("loop_delay_s").value))
        self._max_retries = max(0, int(self.get_parameter("max_retries").value))
        self._goal_timeout_s = max(1.0, float(self.get_parameter("goal_timeout_s").value))
        self._nav_mode = self._normalize_nav_mode(
            str(self.get_parameter("nav_mode").value)
        )

        ok, err, waypoints = load_patrol_waypoints(self._waypoints_file)
        if not ok:
            self.get_logger().warning(err)
            self._waypoints: List[Dict[str, Any]] = []
        else:
            self._waypoints = waypoints

        telemetry_topic = str(self.get_parameter("telemetry_topic").value)
        set_goal_service = str(self.get_parameter("set_goal_service").value)
        cancel_goal_service = str(self.get_parameter("cancel_goal_service").value)
        brake_service = str(self.get_parameter("brake_service").value)
        set_manual_mode_service = str(self.get_parameter("set_manual_mode_service").value)

        self.create_subscription(NavTelemetry, telemetry_topic, self._on_telemetry, 10)
        self.create_service(SetBool, "~/start_patrol", self._on_start_patrol)
        self._status_pub = self.create_publisher(String, "~/patrol_status", 10)
        self.create_timer(0.5, self._publish_status)
        self.create_timer(0.2, self._on_control_timer)

        self._set_goal_client = self.create_client(SetNavGoalLL, set_goal_service)
        self._cancel_goal_client = self.create_client(CancelNavGoal, cancel_goal_service)
        self._brake_client = self.create_client(BrakeNav, brake_service)
        self._set_manual_mode_client = self.create_client(SetManualMode, set_manual_mode_service)

        self.add_on_set_parameters_callback(self._on_set_parameters)
        self.get_logger().info(
            "loop_patrol_runner ready "
            f"(file={self._waypoints_file}, waypoints={len(self._waypoints)}, "
            f"nav_mode={self._nav_mode}, loop_delay_s={self._loop_delay_s:.2f}, "
            f"max_retries={self._max_retries}, goal_timeout_s={self._goal_timeout_s:.1f})"
        )

    @staticmethod
    def _normalize_nav_mode(value: str) -> str:
        normalized = str(value or "global").strip().lower()
        return normalized if normalized in {"global", "local"} else "global"

    def _on_set_parameters(
        self,
        params: List[Parameter],
    ) -> SetParametersResult:
        new_file = self._waypoints_file
        new_nav_mode = self._nav_mode
        for param in params:
            if param.name == "waypoints_file":
                new_file = Path(str(param.value)).expanduser()
            elif param.name == "nav_mode":
                raw_mode = str(param.value or "").strip().lower()
                if raw_mode not in {"global", "local"}:
                    return SetParametersResult(successful=False, reason="invalid nav_mode")
                new_nav_mode = raw_mode

        ok, err, waypoints = load_patrol_waypoints(new_file)
        if not ok:
            return SetParametersResult(successful=False, reason=err)

        with self._lock:
            self._waypoints_file = new_file
            self._waypoints = waypoints
            self._nav_mode = new_nav_mode
            self._current_index = 0
            self._prev_wp_index = -1
            self._retry_count = 0
            self._goal_request_pending = False
            self._manual_disable_pending = False
            self._goal_in_flight = False
            self._goal_sent_monotonic = None
            self._next_dispatch_monotonic = time.monotonic() if self._active else None
        self.get_logger().info(
            f"Reloaded patrol waypoints from {new_file} (count={len(waypoints)})"
        )
        return SetParametersResult(successful=True)

    def _publish_status(self) -> None:
        with self._lock:
            total = len(self._waypoints)
            active = self._active
            index = self._current_index if total > 0 else -1
            label = ""
            if 0 <= index < total:
                label = str(self._waypoints[index].get("label", ""))
        payload = {
            "active": bool(active),
            "current_wp": int(index),
            "total_wp": int(total),
            "label": label,
        }
        msg = String()
        msg.data = json.dumps(payload, ensure_ascii=True)
        self._status_pub.publish(msg)

    def _on_telemetry(self, msg: NavTelemetry) -> None:
        outcome: Optional[str] = None
        with self._lock:
            self._manual_enabled = bool(msg.manual_enabled)
            self._last_nav_result_status = int(msg.nav_result_status)
            self._last_nav_result_text = str(msg.nav_result_text)
            self._last_nav_result_event_id = int(msg.nav_result_event_id)

            if (
                not self._active
                or not self._goal_in_flight
                or self._last_nav_result_event_id <= self._last_handled_nav_result_event_id
            ):
                return

            if self._last_nav_result_status == int(GoalStatus.STATUS_SUCCEEDED):
                self._last_handled_nav_result_event_id = self._last_nav_result_event_id
                outcome = "reached"
            elif self._last_nav_result_status in (
                int(GoalStatus.STATUS_ABORTED),
                int(GoalStatus.STATUS_CANCELED),
            ):
                self._last_handled_nav_result_event_id = self._last_nav_result_event_id
                outcome = "failed"

        if outcome == "reached":
            self._advance_to_next_waypoint()
        elif outcome == "failed":
            self._handle_goal_failure(f"nav result: {self._last_nav_result_text}")

    def _on_start_patrol(
        self,
        request: SetBool.Request,
        response: SetBool.Response,
    ) -> SetBool.Response:
        if bool(request.data):
            ok, err, waypoints = load_patrol_waypoints(self._waypoints_file)
            if not ok:
                response.success = False
                response.message = err
                return response
            with self._lock:
                self._waypoints = waypoints
                if len(self._waypoints) == 0:
                    response.success = False
                    response.message = f"no waypoints loaded from {self._waypoints_file}"
                    return response
                self._active = True
                self._current_index = 0
                self._prev_wp_index = -1
                self._retry_count = 0
                self._goal_request_pending = False
                self._manual_disable_pending = False
                self._goal_in_flight = False
                self._goal_sent_monotonic = None
                self._next_dispatch_monotonic = time.monotonic()
                self._last_handled_nav_result_event_id = int(self._last_nav_result_event_id)
            response.success = True
            response.message = "patrol started"
            return response

        self._stop_patrol("patrol stopped")
        response.success = True
        response.message = "patrol stopped"
        return response

    def _on_control_timer(self) -> None:
        should_timeout = False
        should_dispatch = False
        should_disable_manual = False
        with self._lock:
            if not self._active:
                return
            if self._goal_in_flight and self._goal_sent_monotonic is not None:
                should_timeout = (
                    time.monotonic() - self._goal_sent_monotonic
                ) >= self._goal_timeout_s
            if (
                self._goal_request_pending
                or self._manual_disable_pending
                or self._goal_in_flight
            ):
                pass
            elif (
                self._next_dispatch_monotonic is not None
                and time.monotonic() >= self._next_dispatch_monotonic
            ):
                should_disable_manual = self._manual_enabled
                should_dispatch = not should_disable_manual

        if should_timeout:
            self._handle_goal_timeout()
            return
        if should_disable_manual:
            self._request_manual_disable()
            return
        if should_dispatch:
            self._dispatch_current_waypoint()

    def _request_manual_disable(self) -> None:
        req = SetManualMode.Request()
        req.enabled = False
        if not self._set_manual_mode_client.wait_for_service(timeout_sec=0.1):
            self.get_logger().warning("set_manual_mode service unavailable")
            return
        with self._lock:
            if self._manual_disable_pending or not self._active:
                return
            self._manual_disable_pending = True
        future = self._set_manual_mode_client.call_async(req)
        future.add_done_callback(self._on_manual_disable_done)

    def _on_manual_disable_done(self, future: Any) -> None:
        try:
            response = future.result()
        except Exception as exc:
            with self._lock:
                self._manual_disable_pending = False
                retry_active = self._active
                if retry_active:
                    self._next_dispatch_monotonic = time.monotonic() + 1.0
            self.get_logger().warning(f"set_manual_mode(false) failed: {exc}")
            return

        with self._lock:
            self._manual_disable_pending = False
            retry_active = self._active
            if retry_active:
                self._next_dispatch_monotonic = time.monotonic() + (
                    0.0 if bool(getattr(response, "ok", False)) else 1.0
                )
        if not bool(getattr(response, "ok", False)):
            self.get_logger().warning(
                f"set_manual_mode(false) rejected: {getattr(response, 'error', '')}"
            )

    def _build_goal_request(
        self,
        waypoint: Dict[str, Any],
        *,
        approach_yaw_deg: Optional[float] = None,
    ) -> Tuple[Optional[SetNavGoalLL.Request], str]:
        lat = _finite_float(waypoint.get("lat"))
        lon = _finite_float(waypoint.get("lon"))
        if approach_yaw_deg is not None and math.isfinite(approach_yaw_deg):
            yaw_deg: float = approach_yaw_deg
        else:
            stored = _finite_float(waypoint.get("yaw_deg", 0.0))
            yaw_deg = stored if stored is not None else 0.0

        if self._nav_mode == "local" and not self._warned_local_fallback:
            self.get_logger().warning(
                "nav_mode=local requested, but this checkout only exposes "
                "/nav_command_server/set_goal_ll; falling back to lat/lon waypoints"
            )
            self._warned_local_fallback = True

        if lat is None or lon is None:
            return None, "waypoint is missing lat/lon required by /nav_command_server/set_goal_ll"

        req = SetNavGoalLL.Request()
        req.lat = float(lat)
        req.lon = float(lon)
        req.yaw_deg = float(yaw_deg)
        req.lats = [float(lat)]
        req.lons = [float(lon)]
        req.yaws_deg = [float(yaw_deg)]
        req.loop = False
        return req, ""

    def _dispatch_current_waypoint(self) -> None:
        with self._lock:
            if not self._active or len(self._waypoints) == 0:
                return
            current_idx = self._current_index
            prev_idx = self._prev_wp_index
            waypoint = dict(self._waypoints[current_idx])
            n = len(self._waypoints)
            prev_wp = dict(
                self._waypoints[(current_idx - 1) % n if prev_idx < 0 else prev_idx]
            ) if n >= 2 else None

        approach_yaw_deg: Optional[float] = None
        if prev_wp is not None:
            lat_from = _finite_float(prev_wp.get("lat"))
            lon_from = _finite_float(prev_wp.get("lon"))
            lat_to = _finite_float(waypoint.get("lat"))
            lon_to = _finite_float(waypoint.get("lon"))
            if all(v is not None for v in (lat_from, lon_from, lat_to, lon_to)):
                approach_yaw_deg = _compute_approach_bearing_enu(
                    lat_from, lon_from, lat_to, lon_to  # type: ignore[arg-type]
                )

        request, err = self._build_goal_request(waypoint, approach_yaw_deg=approach_yaw_deg)
        if request is None:
            self._handle_goal_failure(err)
            return

        if not self._set_goal_client.wait_for_service(timeout_sec=0.1):
            self._handle_goal_failure("set_goal_ll service unavailable")
            return

        with self._lock:
            if self._goal_request_pending or self._goal_in_flight or not self._active:
                return
            self._goal_request_pending = True
            self._next_dispatch_monotonic = None

        future = self._set_goal_client.call_async(request)
        future.add_done_callback(self._on_set_goal_done)

    def _on_set_goal_done(self, future: Any) -> None:
        try:
            response = future.result()
        except Exception as exc:
            with self._lock:
                self._goal_request_pending = False
            self._handle_goal_failure(f"set_goal_ll call failed: {exc}")
            return

        with self._lock:
            self._goal_request_pending = False
            still_active = self._active
            current_event_id = self._last_nav_result_event_id

        if not still_active:
            return
        if not bool(getattr(response, "ok", False)):
            self._handle_goal_failure(str(getattr(response, "error", "unknown error")))
            return

        with self._lock:
            if not self._active:
                return
            self._goal_in_flight = True
            self._goal_sent_monotonic = time.monotonic()
            self._last_handled_nav_result_event_id = int(current_event_id)

    def _advance_to_next_waypoint(self) -> None:
        with self._lock:
            if (not self._active) or len(self._waypoints) == 0:
                return
            self._goal_in_flight = False
            self._goal_sent_monotonic = None
            self._retry_count = 0
            self._prev_wp_index = self._current_index
            self._current_index = (self._current_index + 1) % len(self._waypoints)
            self._next_dispatch_monotonic = time.monotonic() + self._loop_delay_s

    def _handle_goal_timeout(self) -> None:
        self.get_logger().warning("patrol goal timed out; cancelling and retrying")
        self._request_cancel_goal()
        self._handle_goal_failure("goal timeout")

    def _handle_goal_failure(self, reason: str) -> None:
        with self._lock:
            if (not self._active) or len(self._waypoints) == 0:
                return
            self._goal_in_flight = False
            self._goal_sent_monotonic = None
            if self._retry_count < self._max_retries:
                self._retry_count += 1
                self._next_dispatch_monotonic = time.monotonic() + self._loop_delay_s
                current_index = self._current_index
                retry_count = self._retry_count
            else:
                self._retry_count = 0
                self._current_index = (self._current_index + 1) % len(self._waypoints)
                self._next_dispatch_monotonic = time.monotonic() + self._loop_delay_s
                current_index = self._current_index
                retry_count = 0
        self.get_logger().warning(
            f"patrol waypoint handling failed: {reason} "
            f"(current_wp={current_index}, retry_count={retry_count})"
        )

    def _request_cancel_goal(self) -> None:
        if not self._cancel_goal_client.wait_for_service(timeout_sec=0.1):
            return
        future = self._cancel_goal_client.call_async(CancelNavGoal.Request())
        future.add_done_callback(lambda _: None)

    def _request_brake(self) -> None:
        if not self._brake_client.wait_for_service(timeout_sec=0.1):
            return
        future = self._brake_client.call_async(BrakeNav.Request())
        future.add_done_callback(lambda _: None)

    def _stop_patrol(self, reason: str) -> None:
        with self._lock:
            self._active = False
            self._prev_wp_index = -1
            self._goal_request_pending = False
            self._manual_disable_pending = False
            self._goal_in_flight = False
            self._goal_sent_monotonic = None
            self._next_dispatch_monotonic = None
        self._request_cancel_goal()
        self._request_brake()
        self.get_logger().info(reason)


def main(args: Optional[list[str]] = None) -> None:
    """Spin the loop patrol runner node until shutdown."""
    rclpy.init(args=args)
    node = LoopPatrolRunnerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()

import json
import math
from typing import Any, Dict, Optional

import rclpy
from action_msgs.msg import GoalStatus
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from geometry_msgs.msg import Twist
from interfaces.msg import CmdVelFinal, NavEvent, NavTelemetry
from nav2_msgs.msg import CollisionMonitorState
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan, NavSatFix
from std_msgs.msg import String


DIAG_OK = int.from_bytes(DiagnosticStatus.OK, byteorder="little", signed=False)
DIAG_WARN = int.from_bytes(DiagnosticStatus.WARN, byteorder="little", signed=False)
DIAG_ERROR = int.from_bytes(DiagnosticStatus.ERROR, byteorder="little", signed=False)


def parse_json_string_payload(data: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(data)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def classify_age(age_s: Optional[float], warn_after_s: float, error_after_s: float) -> int:
    if age_s is None or not math.isfinite(age_s):
        return DIAG_ERROR
    if age_s > error_after_s:
        return DIAG_ERROR
    if age_s > warn_after_s:
        return DIAG_WARN
    return DIAG_OK


class NavObservabilityNode(Node):
    def __init__(self) -> None:
        super().__init__("nav_observability")

        if not self.has_parameter("use_sim_time"):
            self.declare_parameter("use_sim_time", False)
        self.declare_parameter("publish_hz", 2.0)
        self.declare_parameter("gps_stale_warn_s", 1.5)
        self.declare_parameter("gps_stale_error_s", 4.0)
        self.declare_parameter("odom_stale_warn_s", 1.0)
        self.declare_parameter("odom_stale_error_s", 3.0)
        self.declare_parameter("scan_stale_warn_s", 1.0)
        self.declare_parameter("scan_stale_error_s", 3.0)
        self.declare_parameter("cmd_stale_warn_s", 1.0)
        self.declare_parameter("cmd_stale_error_s", 3.0)
        self.declare_parameter("controller_stale_warn_s", 1.0)
        self.declare_parameter("controller_stale_error_s", 3.0)
        self.declare_parameter("nav_telemetry_stale_warn_s", 1.0)
        self.declare_parameter("nav_telemetry_stale_error_s", 3.0)

        self.use_sim_time = bool(self.get_parameter("use_sim_time").value)
        self.publish_hz = max(0.5, float(self.get_parameter("publish_hz").value))
        self.gps_stale_warn_s = float(self.get_parameter("gps_stale_warn_s").value)
        self.gps_stale_error_s = float(self.get_parameter("gps_stale_error_s").value)
        self.odom_stale_warn_s = float(self.get_parameter("odom_stale_warn_s").value)
        self.odom_stale_error_s = float(self.get_parameter("odom_stale_error_s").value)
        self.scan_stale_warn_s = float(self.get_parameter("scan_stale_warn_s").value)
        self.scan_stale_error_s = float(self.get_parameter("scan_stale_error_s").value)
        self.cmd_stale_warn_s = float(self.get_parameter("cmd_stale_warn_s").value)
        self.cmd_stale_error_s = float(self.get_parameter("cmd_stale_error_s").value)
        self.controller_stale_warn_s = float(
            self.get_parameter("controller_stale_warn_s").value
        )
        self.controller_stale_error_s = float(
            self.get_parameter("controller_stale_error_s").value
        )
        self.nav_telemetry_stale_warn_s = float(
            self.get_parameter("nav_telemetry_stale_warn_s").value
        )
        self.nav_telemetry_stale_error_s = float(
            self.get_parameter("nav_telemetry_stale_error_s").value
        )

        self._last_seen: Dict[str, float] = {}
        self._last_collision_stop_active = False
        self._last_nav_telemetry: Optional[NavTelemetry] = None
        self._last_nav_event: Optional[NavEvent] = None
        self._last_controller_status: Optional[Dict[str, Any]] = None
        self._last_controller_telemetry: Optional[Dict[str, Any]] = None

        self._diagnostics_pub = self.create_publisher(DiagnosticArray, "/diagnostics", 10)

        self.create_subscription(NavSatFix, "/gps/fix", self._on_gps_fix, 10)
        self.create_subscription(Odometry, "/odometry/local", self._on_odometry_local, 10)
        self.create_subscription(Odometry, "/odometry/gps", self._on_odometry_gps, 10)
        self.create_subscription(
            LaserScan, "/scan", self._on_scan, qos_profile_sensor_data
        )
        self.create_subscription(Twist, "/cmd_vel", self._on_cmd_vel, 10)
        self.create_subscription(Twist, "/cmd_vel_safe", self._on_cmd_vel_safe, 10)
        self.create_subscription(CmdVelFinal, "/cmd_vel_final", self._on_cmd_vel_final, 10)
        self.create_subscription(
            CollisionMonitorState,
            "/collision_monitor_state",
            self._on_collision_state,
            10,
        )
        self.create_subscription(
            NavTelemetry, "/nav_command_server/telemetry", self._on_nav_telemetry, 10
        )
        self.create_subscription(NavEvent, "/nav_command_server/events", self._on_nav_event, 10)
        self.create_subscription(String, "/controller/status", self._on_controller_status, 10)
        self.create_subscription(
            String, "/controller/telemetry", self._on_controller_telemetry, 10
        )

        self.create_timer(1.0 / self.publish_hz, self._publish_diagnostics)
        self.get_logger().info(
            "nav_observability ready "
            f"(use_sim_time={int(self.use_sim_time)}, diagnostics=/diagnostics)"
        )

    def _mark_seen(self, key: str) -> None:
        self._last_seen[key] = self.get_clock().now().nanoseconds / 1.0e9

    def _age(self, key: str) -> Optional[float]:
        stamp = self._last_seen.get(key)
        if stamp is None:
            return None
        now_s = self.get_clock().now().nanoseconds / 1.0e9
        return max(0.0, now_s - stamp)

    def _on_gps_fix(self, _msg: NavSatFix) -> None:
        self._mark_seen("gps")

    def _on_odometry_local(self, _msg: Odometry) -> None:
        self._mark_seen("odom_local")

    def _on_odometry_gps(self, _msg: Odometry) -> None:
        self._mark_seen("odom_gps")

    def _on_scan(self, _msg: LaserScan) -> None:
        self._mark_seen("scan")

    def _on_cmd_vel(self, _msg: Twist) -> None:
        self._mark_seen("cmd_vel")

    def _on_cmd_vel_safe(self, _msg: Twist) -> None:
        self._mark_seen("cmd_vel_safe")

    def _on_cmd_vel_final(self, _msg: CmdVelFinal) -> None:
        self._mark_seen("cmd_vel_final")

    def _on_collision_state(self, msg: CollisionMonitorState) -> None:
        self._mark_seen("collision_state")
        self._last_collision_stop_active = (
            int(msg.action_type) == int(CollisionMonitorState.STOP)
        )

    def _on_nav_telemetry(self, msg: NavTelemetry) -> None:
        self._mark_seen("nav_telemetry")
        self._last_nav_telemetry = msg

    def _on_nav_event(self, msg: NavEvent) -> None:
        self._mark_seen("nav_event")
        self._last_nav_event = msg

    def _on_controller_status(self, msg: String) -> None:
        parsed = parse_json_string_payload(msg.data)
        if parsed is None:
            return
        self._mark_seen("controller_status")
        self._last_controller_status = parsed

    def _on_controller_telemetry(self, msg: String) -> None:
        parsed = parse_json_string_payload(msg.data)
        if parsed is None:
            return
        self._mark_seen("controller_telemetry")
        self._last_controller_telemetry = parsed

    @staticmethod
    def _kv(key: str, value: Any) -> KeyValue:
        item = KeyValue()
        item.key = str(key)
        item.value = str(value)
        return item

    def _make_status(
        self, name: str, level: int, message: str, values: Dict[str, Any]
    ) -> DiagnosticStatus:
        status = DiagnosticStatus()
        status.name = name
        status.hardware_id = "simulation" if self.use_sim_time else "robot"
        status.level = bytes([int(level) & 0xFF])
        status.message = str(message)
        status.values = [self._kv(key, value) for key, value in values.items()]
        return status

    def _build_gps_status(self) -> DiagnosticStatus:
        age_s = self._age("gps")
        level = classify_age(age_s, self.gps_stale_warn_s, self.gps_stale_error_s)
        msg = "fresh"
        if age_s is None:
            msg = "no fix received"
        elif level == DIAG_WARN:
            msg = "gps stale"
        elif level == DIAG_ERROR:
            msg = "gps missing"
        return self._make_status(
            "navigation/gps",
            level,
            msg,
            {
                "age_s": age_s,
                "gps_fix_available": (
                    self._last_nav_telemetry.gps_fix_available
                    if self._last_nav_telemetry
                    else False
                ),
            },
        )

    def _build_localization_status(self) -> DiagnosticStatus:
        odom_local_age = self._age("odom_local")
        odom_gps_age = self._age("odom_gps")
        level = classify_age(
            odom_local_age, self.odom_stale_warn_s, self.odom_stale_error_s
        )
        msg = "fresh"
        if odom_local_age is None:
            msg = "no /odometry/local received"
        elif level == DIAG_WARN:
            msg = "localization stale"
        elif level == DIAG_ERROR:
            msg = "localization missing"
        return self._make_status(
            "navigation/localization",
            level,
            msg,
            {"odom_local_age_s": odom_local_age, "odom_gps_age_s": odom_gps_age},
        )

    def _build_nav2_command_flow_status(self) -> DiagnosticStatus:
        cmd_vel_age = self._age("cmd_vel")
        cmd_vel_safe_age = self._age("cmd_vel_safe")
        cmd_vel_final_age = self._age("cmd_vel_final")
        goal_active = (
            bool(self._last_nav_telemetry.goal_active)
            if self._last_nav_telemetry
            else False
        )
        auto_mode = (
            str(self._last_nav_telemetry.auto_mode) if self._last_nav_telemetry else ""
        )
        if goal_active:
            level = classify_age(
                cmd_vel_safe_age, self.cmd_stale_warn_s, self.cmd_stale_error_s
            )
            if cmd_vel_safe_age is None:
                msg = "goal active but /cmd_vel_safe missing"
            elif level == DIAG_WARN:
                msg = "goal active but /cmd_vel_safe stale"
            elif level == DIAG_ERROR:
                msg = "goal active but command flow broken"
            else:
                msg = "fresh"
        else:
            level = DIAG_OK
            msg = "idle"
        return self._make_status(
            "navigation/nav2_command_flow",
            level,
            msg,
            {
                "goal_active": goal_active,
                "auto_mode": auto_mode,
                "cmd_vel_age_s": cmd_vel_age,
                "cmd_vel_safe_age_s": cmd_vel_safe_age,
                "cmd_vel_final_age_s": cmd_vel_final_age,
            },
        )

    def _build_collision_monitor_status(self) -> DiagnosticStatus:
        age_s = self._age("collision_state")
        goal_active = (
            bool(self._last_nav_telemetry.goal_active)
            if self._last_nav_telemetry
            else False
        )
        level = classify_age(age_s, self.cmd_stale_warn_s, self.cmd_stale_error_s)
        msg = "fresh"
        if age_s is None:
            level = DIAG_ERROR if goal_active else DIAG_WARN
            msg = (
                "goal active but no collision monitor state"
                if goal_active
                else "no collision monitor state yet"
            )
        elif self._last_collision_stop_active:
            level = max(level, DIAG_WARN)
            msg = "STOP active"
        elif level == DIAG_WARN:
            msg = "collision monitor stale"
        elif level == DIAG_ERROR:
            msg = "collision monitor missing"
        return self._make_status(
            "navigation/collision_monitor",
            level,
            msg,
            {
                "age_s": age_s,
                "collision_stop_active": self._last_collision_stop_active,
                "goal_active": goal_active,
            },
        )

    def _build_nav_command_server_status(self) -> DiagnosticStatus:
        age_s = self._age("nav_telemetry")
        level = classify_age(
            age_s, self.nav_telemetry_stale_warn_s, self.nav_telemetry_stale_error_s
        )
        msg = "fresh"
        failure_code = ""
        failure_component = ""
        if self._last_nav_telemetry is not None:
            failure_code = str(self._last_nav_telemetry.failure_code or "")
            failure_component = str(self._last_nav_telemetry.failure_component or "")
            if failure_code:
                level = max(level, DIAG_ERROR)
                msg = f"failure={failure_code}"
            elif self._last_nav_telemetry.nav_result_status == int(GoalStatus.STATUS_ABORTED):
                level = max(level, DIAG_ERROR)
                msg = "navigation aborted"
        if age_s is None:
            msg = "no nav telemetry"
        elif level == DIAG_WARN and msg == "fresh":
            msg = "nav telemetry stale"
        elif level == DIAG_ERROR and not failure_code and msg == "fresh":
            msg = "nav telemetry missing"
        return self._make_status(
            "navigation/nav_command_server",
            level,
            msg,
            {
                "age_s": age_s,
                "auto_mode": (
                    self._last_nav_telemetry.auto_mode if self._last_nav_telemetry else ""
                ),
                "goal_active": (
                    self._last_nav_telemetry.goal_active
                    if self._last_nav_telemetry
                    else False
                ),
                "failure_code": failure_code,
                "failure_component": failure_component,
                "last_event_code": self._last_nav_event.code if self._last_nav_event else "",
            },
        )

    def _build_controller_server_status(self) -> DiagnosticStatus:
        if self.use_sim_time:
            return self._make_status(
                "navigation/controller_server",
                DIAG_OK,
                "not expected in simulation",
                {"use_sim_time": True},
            )
        status_age = self._age("controller_status")
        telemetry_age = self._age("controller_telemetry")
        level = classify_age(
            telemetry_age, self.controller_stale_warn_s, self.controller_stale_error_s
        )
        msg = "fresh"
        telemetry = (
            self._last_controller_telemetry.get("telemetry", {})
            if self._last_controller_telemetry
            else {}
        )
        controller_source = (
            telemetry.get("control_source") if isinstance(telemetry, dict) else None
        )
        estop_active = (
            bool(telemetry.get("estop_active")) if isinstance(telemetry, dict) else False
        )
        failsafe_active = (
            bool(telemetry.get("failsafe_active")) if isinstance(telemetry, dict) else False
        )
        if telemetry_age is None:
            msg = "no controller telemetry"
        elif estop_active or failsafe_active:
            level = max(level, DIAG_ERROR)
            msg = "controller estop/failsafe active"
        elif level == DIAG_WARN:
            msg = "controller telemetry stale"
        elif level == DIAG_ERROR:
            msg = "controller telemetry missing"
        return self._make_status(
            "navigation/controller_server",
            level,
            msg,
            {
                "controller_status_age_s": status_age,
                "controller_telemetry_age_s": telemetry_age,
                "controller_source": controller_source,
                "estop_active": estop_active,
                "failsafe_active": failsafe_active,
            },
        )

    def _publish_diagnostics(self) -> None:
        msg = DiagnosticArray()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.status = [
            self._build_gps_status(),
            self._build_localization_status(),
            self._build_nav2_command_flow_status(),
            self._build_collision_monitor_status(),
            self._build_nav_command_server_status(),
            self._build_controller_server_status(),
        ]
        self._diagnostics_pub.publish(msg)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = NavObservabilityNode()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, rclpy.executors.ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        try:
            if rclpy.ok():
                rclpy.shutdown()
        except Exception:
            pass

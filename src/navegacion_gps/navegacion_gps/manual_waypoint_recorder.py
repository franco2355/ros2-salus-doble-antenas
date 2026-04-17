from __future__ import annotations
"""ROS 2 node that records manual GPS waypoints into a YAML file."""

import math
from pathlib import Path
import threading
from typing import Optional

from interfaces.msg import NavTelemetry
from nav_msgs.msg import Odometry
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import NavSatFix
from std_msgs.msg import Int32
from std_srvs.srv import SetBool, Trigger

from .manual_waypoint_recorder_core import GpsFixSample
from .manual_waypoint_recorder_core import ManualWaypointRecorderCore
from .manual_waypoint_recorder_core import OdomSnapshot
from .manual_waypoint_recorder_core import covariance_0_or_inf
from .manual_waypoint_recorder_core import save_recorded_waypoints_yaml


def _yaw_deg_from_quaternion(x: float, y: float, z: float, w: float) -> Optional[float]:
    norm = (x * x) + (y * y) + (z * z) + (w * w)
    if norm <= 1.0e-12:
        return None
    inv_norm = float(norm) ** -0.5
    x *= inv_norm
    y *= inv_norm
    z *= inv_norm
    w *= inv_norm
    siny_cosp = 2.0 * ((w * z) + (x * y))
    cosy_cosp = 1.0 - (2.0 * ((y * y) + (z * z)))
    return float(math.degrees(math.atan2(siny_cosp, cosy_cosp)))


class ManualWaypointRecorderNode(Node):
    """Collect manual-drive GPS waypoints at a minimum spacing."""

    def __init__(self) -> None:
        super().__init__("manual_waypoint_recorder")

        self.declare_parameter("min_distance_m", 3.0)
        self.declare_parameter("output_file", "~/.ros/recorded_waypoints.yaml")
        self.declare_parameter("gps_topic", "/gps/fix")
        self.declare_parameter("odom_topic", "/odometry/local")
        self.declare_parameter("max_covariance", 4.0)
        self.declare_parameter("telemetry_topic", "/nav_command_server/telemetry")

        self._lock = threading.Lock()
        self._recording = False
        self._latest_odom_snapshot: Optional[OdomSnapshot] = None
        self._telemetry_manual_enabled: Optional[bool] = None

        self._core = ManualWaypointRecorderCore(
            min_distance_m=float(self.get_parameter("min_distance_m").value),
            max_covariance=float(self.get_parameter("max_covariance").value),
        )
        self._output_file = self._resolve_output_file(
            str(self.get_parameter("output_file").value)
        )

        gps_topic = str(self.get_parameter("gps_topic").value)
        odom_topic = str(self.get_parameter("odom_topic").value)
        telemetry_topic = str(self.get_parameter("telemetry_topic").value)

        self.create_subscription(NavSatFix, gps_topic, self._on_gps_fix, qos_profile_sensor_data)
        self.create_subscription(Odometry, odom_topic, self._on_odometry, 10)
        self.create_subscription(NavTelemetry, telemetry_topic, self._on_telemetry, 10)

        self.create_service(SetBool, "~/start_recording", self._on_start_recording)
        self.create_service(Trigger, "~/clear_recording", self._on_clear_recording)

        self._count_pub = self.create_publisher(Int32, "~/waypoint_count", 10)
        self.create_timer(1.0, self._publish_waypoint_count)

        self.get_logger().info(
            "manual_waypoint_recorder ready "
            f"(gps={gps_topic}, odom={odom_topic}, telemetry={telemetry_topic}, "
            f"min_distance_m={self._core.min_distance_m:.2f}, output={self._output_file})"
        )

    @staticmethod
    def _resolve_output_file(value: str) -> Path:
        return Path(str(value)).expanduser()

    def _publish_waypoint_count(self) -> None:
        with self._lock:
            count = self._core.count
        msg = Int32()
        msg.data = int(count)
        self._count_pub.publish(msg)

    def _on_telemetry(self, msg: NavTelemetry) -> None:
        with self._lock:
            self._telemetry_manual_enabled = bool(msg.manual_enabled)

    def _on_odometry(self, msg: Odometry) -> None:
        yaw_deg = _yaw_deg_from_quaternion(
            float(msg.pose.pose.orientation.x),
            float(msg.pose.pose.orientation.y),
            float(msg.pose.pose.orientation.z),
            float(msg.pose.pose.orientation.w),
        )
        if yaw_deg is None:
            return
        with self._lock:
            self._latest_odom_snapshot = OdomSnapshot(
                x=float(msg.pose.pose.position.x),
                y=float(msg.pose.pose.position.y),
                yaw_deg=float(yaw_deg),
            )

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        with self._lock:
            if not self._recording:
                return
            if self._telemetry_manual_enabled is False:
                return
            odom_snapshot = self._latest_odom_snapshot
            covariance_0 = covariance_0_or_inf(msg.position_covariance)
            result = self._core.process_fix(
                GpsFixSample(
                    lat=float(msg.latitude),
                    lon=float(msg.longitude),
                    status=int(msg.status.status),
                    covariance_0=covariance_0,
                ),
                odom_snapshot=odom_snapshot,
            )

        if result is None:
            return

        waypoint, distance_m = result
        self.get_logger().info(
            "Recorded "
            f"{waypoint['label']} at "
            f"({float(waypoint['lat']):.7f}, {float(waypoint['lon']):.7f}), "
            f"d={float(distance_m):.2f}m"
        )

    def _save_current_session_locked(self) -> tuple[bool, str]:
        ok, err, count = save_recorded_waypoints_yaml(
            self._output_file,
            self._core.waypoints(),
        )
        if ok:
            return True, f"saved {count} waypoint(s) to {self._output_file}"
        return False, err

    def _on_start_recording(
        self,
        request: SetBool.Request,
        response: SetBool.Response,
    ) -> SetBool.Response:
        if bool(request.data):
            with self._lock:
                already_recording = self._recording
                if not already_recording:
                    self._core.clear()
                    self._recording = True
            response.success = True
            response.message = (
                "recording already active"
                if already_recording
                else f"recording started; output={self._output_file}"
            )
            return response

        with self._lock:
            self._recording = False
            ok, message = self._save_current_session_locked()
        response.success = bool(ok)
        response.message = str(message)
        return response

    def _on_clear_recording(
        self,
        _request: Trigger.Request,
        response: Trigger.Response,
    ) -> Trigger.Response:
        with self._lock:
            self._core.clear()
        response.success = True
        response.message = "recording cleared"
        return response

    def close(self) -> None:
        with self._lock:
            if not self._recording:
                return
            self._recording = False
            ok, message = self._save_current_session_locked()
        if ok:
            self.get_logger().info(f"Auto-saved recording on shutdown: {message}")
        else:
            self.get_logger().warning(f"Failed to auto-save recording on shutdown: {message}")


def main(args: Optional[list[str]] = None) -> None:
    """Spin the waypoint recorder node until shutdown."""
    rclpy.init(args=args)
    node = ManualWaypointRecorderNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.close()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()

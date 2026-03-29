from __future__ import annotations

from copy import deepcopy
import time
from typing import Optional

import rclpy
from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry
from rclpy.node import Node


class GlobalOdomStationaryGateNode(Node):
    def __init__(self) -> None:
        super().__init__("global_odom_stationary_gate")

        self.declare_parameter("input_odom_topic", "/odometry/local")
        self.declare_parameter("output_odom_topic", "/odometry/local_global")
        self.declare_parameter("drive_telemetry_topic", "/controller/drive_telemetry")
        self.declare_parameter("stationary_speed_threshold_mps", 0.03)
        self.declare_parameter("drive_telemetry_timeout_s", 0.5)

        input_odom_topic = str(self.get_parameter("input_odom_topic").value)
        output_odom_topic = str(self.get_parameter("output_odom_topic").value)
        drive_telemetry_topic = str(self.get_parameter("drive_telemetry_topic").value)

        self._stationary_speed_threshold_mps = max(
            0.0,
            float(self.get_parameter("stationary_speed_threshold_mps").value),
        )
        self._drive_telemetry_timeout_s = max(
            0.0,
            float(self.get_parameter("drive_telemetry_timeout_s").value),
        )
        self._last_drive_telemetry: Optional[DriveTelemetry] = None
        self._last_drive_telemetry_monotonic_s: Optional[float] = None

        self._odom_pub = self.create_publisher(Odometry, output_odom_topic, 10)
        self.create_subscription(Odometry, input_odom_topic, self._on_odometry, 10)
        self.create_subscription(
            DriveTelemetry,
            drive_telemetry_topic,
            self._on_drive_telemetry,
            10,
        )

        self.get_logger().info(
            "global_odom_stationary_gate ready "
            f"({input_odom_topic} -> {output_odom_topic}, "
            f"drive={drive_telemetry_topic}, "
            f"speed_threshold={self._stationary_speed_threshold_mps:.3f}m/s, "
            f"timeout={self._drive_telemetry_timeout_s:.3f}s)"
        )

    def _monotonic_now_s(self) -> float:
        return time.monotonic()

    def _on_drive_telemetry(self, msg: DriveTelemetry) -> None:
        self._last_drive_telemetry = msg
        self._last_drive_telemetry_monotonic_s = self._monotonic_now_s()

    def _stationary_gate_active(self) -> bool:
        msg = self._last_drive_telemetry
        if msg is None or self._last_drive_telemetry_monotonic_s is None:
            return False
        if (
            self._monotonic_now_s() - self._last_drive_telemetry_monotonic_s
        ) > self._drive_telemetry_timeout_s:
            return False
        if not bool(msg.fresh) or not bool(msg.speed_valid):
            return False
        return abs(float(msg.speed_mps_measured)) <= self._stationary_speed_threshold_mps

    @staticmethod
    def _zero_twist(msg: Odometry) -> Odometry:
        gated = deepcopy(msg)
        gated.twist.twist.linear.x = 0.0
        gated.twist.twist.linear.y = 0.0
        gated.twist.twist.linear.z = 0.0
        gated.twist.twist.angular.x = 0.0
        gated.twist.twist.angular.y = 0.0
        gated.twist.twist.angular.z = 0.0
        return gated

    def _on_odometry(self, msg: Odometry) -> None:
        if self._stationary_gate_active():
            self._odom_pub.publish(self._zero_twist(msg))
            return
        self._odom_pub.publish(deepcopy(msg))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = GlobalOdomStationaryGateNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

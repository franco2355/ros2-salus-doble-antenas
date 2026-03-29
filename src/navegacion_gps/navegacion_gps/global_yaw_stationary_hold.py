from __future__ import annotations

from copy import deepcopy
import math
import time
from typing import Optional

import rclpy
from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry
from rclpy.node import Node


class GlobalYawStationaryHoldNode(Node):
    def __init__(self) -> None:
        super().__init__("global_yaw_stationary_hold")

        self.declare_parameter("input_odom_topic", "/odometry/local")
        self.declare_parameter("output_odom_topic", "/odometry/local_yaw_hold")
        self.declare_parameter("drive_telemetry_topic", "/controller/drive_telemetry")
        self.declare_parameter("stationary_speed_threshold_mps", 0.03)
        self.declare_parameter("drive_telemetry_timeout_s", 0.5)
        self.declare_parameter("yaw_variance_rad2", 0.01)

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
        self._yaw_variance_rad2 = max(
            1.0e-6,
            float(self.get_parameter("yaw_variance_rad2").value),
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
            "global_yaw_stationary_hold ready "
            f"({input_odom_topic} -> {output_odom_topic}, "
            f"drive={drive_telemetry_topic}, "
            f"speed_threshold={self._stationary_speed_threshold_mps:.3f}m/s, "
            f"timeout={self._drive_telemetry_timeout_s:.3f}s, "
            f"yaw_variance={self._yaw_variance_rad2:.6f}rad^2)"
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
    def _orientation_is_finite(msg: Odometry) -> bool:
        q = msg.pose.pose.orientation
        if not all(
            math.isfinite(value) for value in (q.x, q.y, q.z, q.w)
        ):
            return False
        norm = (q.x * q.x) + (q.y * q.y) + (q.z * q.z) + (q.w * q.w)
        return norm > 1.0e-9

    @staticmethod
    def _make_large_diagonal_covariance() -> list[float]:
        covariance = [0.0] * 36
        for index in (0, 7, 14, 21, 28, 35):
            covariance[index] = 1.0e6
        return covariance

    def _yaw_only_measurement(self, msg: Odometry) -> Odometry:
        gated = deepcopy(msg)
        covariance = self._make_large_diagonal_covariance()
        covariance[35] = self._yaw_variance_rad2
        gated.pose.covariance = covariance
        return gated

    def _on_odometry(self, msg: Odometry) -> None:
        if not self._stationary_gate_active():
            return
        if not self._orientation_is_finite(msg):
            return
        self._odom_pub.publish(self._yaw_only_measurement(msg))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = GlobalYawStationaryHoldNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

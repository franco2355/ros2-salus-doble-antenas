from __future__ import annotations

import json
import math
from typing import Optional

import rclpy
from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu, NavSatFix
from std_msgs.msg import String

from navegacion_gps.gps_course_heading_core import CourseHeadingEstimate
from navegacion_gps.gps_course_heading_core import GpsCourseHeadingEstimator


def _stamp_to_seconds(stamp) -> float:
    return float(stamp.sec) + float(stamp.nanosec) / 1_000_000_000.0


def _quaternion_from_yaw_deg(yaw_deg: float) -> tuple[float, float, float, float]:
    yaw_rad = math.radians(float(yaw_deg))
    half_yaw = 0.5 * yaw_rad
    return (0.0, 0.0, math.sin(half_yaw), math.cos(half_yaw))


class GpsCourseHeadingNode(Node):
    def __init__(self) -> None:
        super().__init__("gps_course_heading")

        if not self.has_parameter("use_sim_time"):
            self.declare_parameter("use_sim_time", False)
        self.declare_parameter("gps_topic", "/gps/fix")
        self.declare_parameter("odom_topic", "/odometry/local")
        self.declare_parameter("drive_telemetry_topic", "/controller/drive_telemetry")
        self.declare_parameter("output_topic", "/gps/course_heading")
        self.declare_parameter("debug_topic", "/gps/course_heading/debug")
        self.declare_parameter("base_frame", "base_footprint")
        self.declare_parameter("min_distance_m", 2.5)
        self.declare_parameter("min_speed_mps", 0.8)
        self.declare_parameter("max_abs_steer_deg", 6.0)
        self.declare_parameter("max_abs_yaw_rate_rps", 0.12)
        self.declare_parameter("max_fix_age_s", 0.5)
        self.declare_parameter("publish_hz", 5.0)
        self.declare_parameter("yaw_variance_rad2", 0.20)

        gps_topic = str(self.get_parameter("gps_topic").value)
        odom_topic = str(self.get_parameter("odom_topic").value)
        drive_telemetry_topic = str(self.get_parameter("drive_telemetry_topic").value)
        output_topic = str(self.get_parameter("output_topic").value)
        debug_topic = str(self.get_parameter("debug_topic").value)

        self._base_frame = str(self.get_parameter("base_frame").value)
        self._publish_hz = max(1.0, float(self.get_parameter("publish_hz").value))
        self._yaw_variance_rad2 = max(
            1.0e-6, float(self.get_parameter("yaw_variance_rad2").value)
        )
        self._estimator = GpsCourseHeadingEstimator(
            min_distance_m=float(self.get_parameter("min_distance_m").value),
            min_speed_mps=float(self.get_parameter("min_speed_mps").value),
            max_abs_steer_deg=float(self.get_parameter("max_abs_steer_deg").value),
            max_abs_yaw_rate_rps=float(
                self.get_parameter("max_abs_yaw_rate_rps").value
            ),
            max_fix_age_s=float(self.get_parameter("max_fix_age_s").value),
        )

        self._last_fix_stamp_s: Optional[float] = None
        self._last_local_speed_mps: float = 0.0
        self._last_local_yaw_rate_rps: float = 0.0
        self._last_steer_deg: Optional[float] = None
        self._last_steer_valid = False
        self._last_drive_fresh = False
        self._last_drive_speed_mps = 0.0

        self._imu_pub = self.create_publisher(Imu, output_topic, 10)
        self._debug_pub = self.create_publisher(String, debug_topic, 10)
        self.create_subscription(NavSatFix, gps_topic, self._on_gps_fix, qos_profile_sensor_data)
        self.create_subscription(Odometry, odom_topic, self._on_odometry, 10)
        self.create_subscription(
            DriveTelemetry,
            drive_telemetry_topic,
            self._on_drive_telemetry,
            10,
        )
        self.create_timer(1.0 / self._publish_hz, self._on_publish_timer)
        self.get_logger().info(
            "gps_course_heading ready "
            f"(gps={gps_topic}, odom={odom_topic}, drive={drive_telemetry_topic}, "
            f"output={output_topic}, debug={debug_topic})"
        )

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        if not math.isfinite(float(msg.latitude)) or not math.isfinite(float(msg.longitude)):
            return
        stamp_s = _stamp_to_seconds(msg.header.stamp)
        if stamp_s <= 0.0:
            stamp_s = self.get_clock().now().nanoseconds / 1.0e9
        self._last_fix_stamp_s = float(stamp_s)
        self._estimator.add_fix(
            lat=float(msg.latitude),
            lon=float(msg.longitude),
            stamp_s=float(stamp_s),
        )

    def _on_odometry(self, msg: Odometry) -> None:
        self._last_local_speed_mps = float(msg.twist.twist.linear.x)
        self._last_local_yaw_rate_rps = float(msg.twist.twist.angular.z)

    def _on_drive_telemetry(self, msg: DriveTelemetry) -> None:
        self._last_steer_valid = bool(msg.steer_valid)
        self._last_drive_fresh = bool(msg.fresh)
        self._last_drive_speed_mps = float(msg.speed_mps_measured)
        if self._last_steer_valid and math.isfinite(float(msg.steer_deg_measured)):
            self._last_steer_deg = float(msg.steer_deg_measured)
        else:
            self._last_steer_deg = None

    def _on_publish_timer(self) -> None:
        now_s = self.get_clock().now().nanoseconds / 1.0e9
        speed_mps = float(self._last_local_speed_mps)
        if abs(speed_mps) < 1.0e-6:
            speed_mps = float(self._last_drive_speed_mps)
        estimate = self._estimator.estimate(
            now_s=float(now_s),
            speed_mps=float(speed_mps),
            steer_deg=self._last_steer_deg,
            steer_valid=bool(self._last_steer_valid and self._last_drive_fresh),
            yaw_rate_rps=float(self._last_local_yaw_rate_rps),
        )
        self._publish_debug(estimate)
        if estimate.valid and estimate.yaw_deg is not None:
            self._publish_imu(estimate)

    def _publish_imu(self, estimate: CourseHeadingEstimate) -> None:
        msg = Imu()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self._base_frame
        qx, qy, qz, qw = _quaternion_from_yaw_deg(float(estimate.yaw_deg))
        msg.orientation.x = qx
        msg.orientation.y = qy
        msg.orientation.z = qz
        msg.orientation.w = qw
        msg.orientation_covariance = [
            1.0e6,
            0.0,
            0.0,
            0.0,
            1.0e6,
            0.0,
            0.0,
            0.0,
            float(self._yaw_variance_rad2),
        ]
        msg.angular_velocity_covariance = [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        msg.linear_acceleration_covariance = [
            -1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]
        self._imu_pub.publish(msg)

    def _publish_debug(self, estimate: CourseHeadingEstimate) -> None:
        payload = {
            "valid": bool(estimate.valid),
            "reason": estimate.reason,
            "yaw_deg": estimate.yaw_deg,
            "distance_m": estimate.distance_m,
            "speed_mps": estimate.speed_mps,
            "steer_deg": estimate.steer_deg,
            "yaw_rate_rps": estimate.yaw_rate_rps,
            "latest_fix_age_s": estimate.latest_fix_age_s,
            "sample_dt_s": estimate.sample_dt_s,
            "base_frame": self._base_frame,
        }
        msg = String()
        msg.data = json.dumps(payload, sort_keys=True)
        self._debug_pub.publish(msg)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = GpsCourseHeadingNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

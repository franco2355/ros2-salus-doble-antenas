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


def normalize_rtk_status_label(status_text: str) -> str:
    text = str(status_text).strip().lower()
    for old, new in (("-", "_"), (" ", "_")):
        text = text.replace(old, new)
    text = "_".join(part for part in text.split("_") if part)
    if "rtk_fixed" in text:
        return "rtk_fixed"
    if "rtk_float" in text:
        return "rtk_float"
    if "rtk_fix" in text:
        return "rtk_fix"
    return text


def parse_allowed_rtk_statuses(raw_value: str) -> tuple[str, ...]:
    allowed_statuses = []
    for token in str(raw_value).split(","):
        normalized = normalize_rtk_status_label(token)
        if normalized and normalized not in allowed_statuses:
            allowed_statuses.append(normalized)
    return tuple(allowed_statuses)


def is_rtk_status_allowed(status_text: str, allowed_statuses: tuple[str, ...]) -> bool:
    normalized_status = normalize_rtk_status_label(status_text)
    return bool(normalized_status) and normalized_status in allowed_statuses


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
        self.declare_parameter("invalid_hold_s", 0.0)
        self.declare_parameter("max_sample_dt_s", 0.0)
        self.declare_parameter("publish_hz", 5.0)
        self.declare_parameter("yaw_variance_rad2", 0.20)
        self.declare_parameter("hold_yaw_variance_multiplier", 4.0)
        self.declare_parameter("rtk_status_topic", "/gps/rtk_status")
        self.declare_parameter("require_rtk", False)
        self.declare_parameter("allowed_rtk_statuses", "RTK_FIXED,RTK_FIX")
        self.declare_parameter("rtk_status_max_age_s", 2.5)

        gps_topic = str(self.get_parameter("gps_topic").value)
        odom_topic = str(self.get_parameter("odom_topic").value)
        drive_telemetry_topic = str(self.get_parameter("drive_telemetry_topic").value)
        output_topic = str(self.get_parameter("output_topic").value)
        debug_topic = str(self.get_parameter("debug_topic").value)
        rtk_status_topic = str(self.get_parameter("rtk_status_topic").value)

        self._base_frame = str(self.get_parameter("base_frame").value)
        self._publish_hz = max(1.0, float(self.get_parameter("publish_hz").value))
        self._yaw_variance_rad2 = max(
            1.0e-6, float(self.get_parameter("yaw_variance_rad2").value)
        )
        self._hold_yaw_variance_multiplier = max(
            1.0, float(self.get_parameter("hold_yaw_variance_multiplier").value)
        )
        self._require_rtk = bool(self.get_parameter("require_rtk").value)
        self._allowed_rtk_statuses = parse_allowed_rtk_statuses(
            str(self.get_parameter("allowed_rtk_statuses").value)
        )
        self._rtk_status_max_age_s = max(
            0.1, float(self.get_parameter("rtk_status_max_age_s").value)
        )
        self._estimator = GpsCourseHeadingEstimator(
            min_distance_m=float(self.get_parameter("min_distance_m").value),
            min_speed_mps=float(self.get_parameter("min_speed_mps").value),
            max_abs_steer_deg=float(self.get_parameter("max_abs_steer_deg").value),
            max_abs_yaw_rate_rps=float(
                self.get_parameter("max_abs_yaw_rate_rps").value
            ),
            max_fix_age_s=float(self.get_parameter("max_fix_age_s").value),
            invalid_hold_s=float(self.get_parameter("invalid_hold_s").value),
            max_sample_dt_s=float(self.get_parameter("max_sample_dt_s").value),
        )

        self._last_fix_stamp_s: Optional[float] = None
        self._last_local_speed_mps: float = 0.0
        self._last_local_yaw_rate_rps: float = 0.0
        self._last_steer_deg: Optional[float] = None
        self._last_steer_valid = False
        self._last_drive_fresh = False
        self._last_drive_speed_mps = 0.0
        self._last_rtk_status_text = ""
        self._last_rtk_status_stamp_s: Optional[float] = None

        self._imu_pub = self.create_publisher(Imu, output_topic, 10)
        self._debug_pub = self.create_publisher(String, debug_topic, 10)
        self.create_subscription(NavSatFix, gps_topic, self._on_gps_fix, qos_profile_sensor_data)
        self.create_subscription(Odometry, odom_topic, self._on_odometry, 10)
        self.create_subscription(String, rtk_status_topic, self._on_rtk_status, 10)
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
            f"output={output_topic}, debug={debug_topic}, "
            f"require_rtk={self._require_rtk}, rtk_status={rtk_status_topic})"
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

    def _on_rtk_status(self, msg: String) -> None:
        self._last_rtk_status_text = str(msg.data)
        self._last_rtk_status_stamp_s = self.get_clock().now().nanoseconds / 1.0e9

    def _rtk_status_age_s(self, now_s: float) -> Optional[float]:
        if self._last_rtk_status_stamp_s is None:
            return None
        return max(0.0, float(now_s) - float(self._last_rtk_status_stamp_s))

    def _rtk_gate_reason(self, now_s: float) -> Optional[str]:
        if not self._require_rtk:
            return None
        if not self._last_rtk_status_text.strip() or self._last_rtk_status_stamp_s is None:
            return "rtk_status_missing"
        rtk_status_age_s = self._rtk_status_age_s(now_s)
        if rtk_status_age_s is None or rtk_status_age_s > self._rtk_status_max_age_s:
            return "rtk_status_stale"
        if not is_rtk_status_allowed(self._last_rtk_status_text, self._allowed_rtk_statuses):
            return "rtk_status_rejected"
        return None

    def _build_invalid_estimate(self, now_s: float, reason: str) -> CourseHeadingEstimate:
        latest_fix_age_s = None
        if self._last_fix_stamp_s is not None:
            latest_fix_age_s = max(0.0, float(now_s) - float(self._last_fix_stamp_s))
        steer_deg = self._last_steer_deg
        if steer_deg is not None and not math.isfinite(float(steer_deg)):
            steer_deg = None
        speed_mps = float(self._last_local_speed_mps)
        if abs(speed_mps) < 1.0e-6:
            speed_mps = float(self._last_drive_speed_mps)
        return CourseHeadingEstimate(
            valid=False,
            reason=str(reason),
            yaw_deg=None,
            distance_m=0.0,
            speed_mps=float(speed_mps),
            steer_deg=steer_deg,
            yaw_rate_rps=float(self._last_local_yaw_rate_rps),
            latest_fix_age_s=latest_fix_age_s,
            sample_dt_s=None,
        )

    def _on_publish_timer(self) -> None:
        now_s = self.get_clock().now().nanoseconds / 1.0e9
        rtk_gate_reason = self._rtk_gate_reason(now_s)
        if rtk_gate_reason is not None:
            estimate = self._build_invalid_estimate(now_s=float(now_s), reason=rtk_gate_reason)
        else:
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
        yaw_variance_rad2 = self._yaw_variance_rad2
        if str(estimate.reason).startswith("hold_"):
            yaw_variance_rad2 *= self._hold_yaw_variance_multiplier
        msg.orientation_covariance = [
            1.0e6,
            0.0,
            0.0,
            0.0,
            1.0e6,
            0.0,
            0.0,
            0.0,
            float(yaw_variance_rad2),
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
        now_s = self.get_clock().now().nanoseconds / 1.0e9
        rtk_status_age_s = self._rtk_status_age_s(now_s)
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
            "rtk_required": bool(self._require_rtk),
            "rtk_status": self._last_rtk_status_text,
            "rtk_status_normalized": normalize_rtk_status_label(self._last_rtk_status_text),
            "rtk_status_age_s": rtk_status_age_s,
            "rtk_allowed_statuses": list(self._allowed_rtk_statuses),
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

from __future__ import annotations

from copy import deepcopy
import math

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node
from sensor_msgs.msg import Imu, NavSatFix, PointCloud2
from std_msgs.msg import String

from navegacion_gps.gps_profiles import (
    SimGpsFixProcessor,
    resolve_gps_profile,
    stamp_to_nanoseconds,
)


DEFAULT_IMU_ORIENTATION_VARIANCE = 0.01
DEFAULT_IMU_ANGULAR_VELOCITY_VARIANCE = 0.01
DEFAULT_IMU_LINEAR_ACCELERATION_VARIANCE = 0.1


def _covariance_is_zero(values) -> bool:
    return all(abs(float(value)) <= 1.0e-12 for value in values)


class SimSensorNormalizerV2Node(Node):
    def __init__(self) -> None:
        super().__init__("sim_sensor_normalizer_v2")

        self.declare_parameter("imu_in_topic", "/imu/data_raw")
        self.declare_parameter("imu_out_topic", "/imu/data")
        self.declare_parameter("gps_in_topic", "/gps/fix_raw")
        self.declare_parameter("gps_out_topic", "/gps/fix")
        self.declare_parameter("lidar_in_topic", "/scan_3d_raw")
        self.declare_parameter("lidar_out_topic", "/scan_3d")
        self.declare_parameter("odom_in_topic", "/odom_raw")
        self.declare_parameter("odom_out_topic", "/odom")
        self.declare_parameter("imu_frame_id", "imu_link")
        self.declare_parameter("gps_frame_id", "gps_link")
        self.declare_parameter("lidar_frame_id", "lidar_link")
        self.declare_parameter("odom_frame_id", "odom")
        self.declare_parameter("base_link_frame_id", "base_footprint")
        # The modern sim launches select a named GPS behavior profile instead of
        # scattering noise constants across launch files.
        self.declare_parameter("gps_profile", "ideal")
        self.declare_parameter("gps_random_seed", 0)
        self.declare_parameter("gps_rtk_status_topic", "/gps/rtk_status")
        self.declare_parameter("gps_hold_when_stationary", False)
        self.declare_parameter("gps_hold_linear_speed_threshold_mps", 0.02)
        self.declare_parameter("gps_hold_yaw_rate_threshold_rps", 0.01)

        imu_in_topic = str(self.get_parameter("imu_in_topic").value)
        imu_out_topic = str(self.get_parameter("imu_out_topic").value)
        gps_in_topic = str(self.get_parameter("gps_in_topic").value)
        gps_out_topic = str(self.get_parameter("gps_out_topic").value)
        lidar_in_topic = str(self.get_parameter("lidar_in_topic").value)
        lidar_out_topic = str(self.get_parameter("lidar_out_topic").value)
        odom_in_topic = str(self.get_parameter("odom_in_topic").value)
        odom_out_topic = str(self.get_parameter("odom_out_topic").value)

        self._imu_frame_id = str(self.get_parameter("imu_frame_id").value)
        self._gps_frame_id = str(self.get_parameter("gps_frame_id").value)
        self._lidar_frame_id = str(self.get_parameter("lidar_frame_id").value)
        self._odom_frame_id = str(self.get_parameter("odom_frame_id").value)
        self._base_link_frame_id = str(self.get_parameter("base_link_frame_id").value)
        gps_profile_name = str(self.get_parameter("gps_profile").value)
        gps_random_seed = int(self.get_parameter("gps_random_seed").value)
        gps_rtk_status_topic = str(self.get_parameter("gps_rtk_status_topic").value)
        self._gps_hold_when_stationary = bool(
            self.get_parameter("gps_hold_when_stationary").value
        )
        self._gps_hold_linear_speed_threshold_mps = float(
            self.get_parameter("gps_hold_linear_speed_threshold_mps").value
        )
        self._gps_hold_yaw_rate_threshold_rps = float(
            self.get_parameter("gps_hold_yaw_rate_threshold_rps").value
        )
        self._gps_profile = resolve_gps_profile(gps_profile_name)
        self._gps_processor = SimGpsFixProcessor(
            self._gps_profile, random_seed=gps_random_seed
        )
        self._last_odom_linear_speed_mps = 0.0
        self._last_odom_yaw_rate_rps = 0.0
        self._last_gps_out: NavSatFix | None = None

        self._imu_pub = self.create_publisher(Imu, imu_out_topic, 10)
        self._gps_pub = self.create_publisher(NavSatFix, gps_out_topic, 10)
        self._gps_rtk_status_pub = self.create_publisher(String, gps_rtk_status_topic, 10)
        self._lidar_pub = self.create_publisher(PointCloud2, lidar_out_topic, 10)
        self._odom_pub = self.create_publisher(Odometry, odom_out_topic, 10)

        self.create_subscription(Imu, imu_in_topic, self._on_imu, 10)
        self.create_subscription(NavSatFix, gps_in_topic, self._on_gps, 10)
        self.create_subscription(PointCloud2, lidar_in_topic, self._on_lidar, 10)
        self.create_subscription(Odometry, odom_in_topic, self._on_odom, 10)

        self.get_logger().info(
            "sim_sensor_normalizer_v2 ready "
            f"({imu_in_topic},{gps_in_topic},{lidar_in_topic},{odom_in_topic}) "
            f"gps_profile={self._gps_profile.name}"
        )

    def _on_imu(self, msg: Imu) -> None:
        out = deepcopy(msg)
        out.header.frame_id = self._imu_frame_id
        if _covariance_is_zero(out.orientation_covariance):
            out.orientation_covariance = [
                DEFAULT_IMU_ORIENTATION_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_ORIENTATION_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_ORIENTATION_VARIANCE,
            ]
        if _covariance_is_zero(out.angular_velocity_covariance):
            out.angular_velocity_covariance = [
                DEFAULT_IMU_ANGULAR_VELOCITY_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_ANGULAR_VELOCITY_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_ANGULAR_VELOCITY_VARIANCE,
            ]
        if _covariance_is_zero(out.linear_acceleration_covariance):
            out.linear_acceleration_covariance = [
                DEFAULT_IMU_LINEAR_ACCELERATION_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_LINEAR_ACCELERATION_VARIANCE,
                0.0,
                0.0,
                0.0,
                DEFAULT_IMU_LINEAR_ACCELERATION_VARIANCE,
            ]
        self._imu_pub.publish(out)

    def _on_gps(self, msg: NavSatFix) -> None:
        if self._should_hold_gps():
            out = deepcopy(self._last_gps_out)
            out.header.stamp = msg.header.stamp
            out.header.frame_id = self._gps_frame_id
            self._gps_pub.publish(out)
            self._gps_rtk_status_pub.publish(
                String(data=self._gps_processor.rtk_status_text())
            )
            return
        reference_time_ns = stamp_to_nanoseconds(msg)
        out = self._gps_processor.process_fix(msg, reference_time_ns)
        if out is None:
            return
        out.header.frame_id = self._gps_frame_id
        self._last_gps_out = deepcopy(out)
        self._gps_pub.publish(out)
        self._gps_rtk_status_pub.publish(
            String(data=self._gps_processor.rtk_status_text())
        )

    def _on_lidar(self, msg: PointCloud2) -> None:
        out = deepcopy(msg)
        out.header.frame_id = self._lidar_frame_id
        self._lidar_pub.publish(out)

    def _on_odom(self, msg: Odometry) -> None:
        self._last_odom_linear_speed_mps = math.hypot(
            float(msg.twist.twist.linear.x),
            float(msg.twist.twist.linear.y),
        )
        self._last_odom_yaw_rate_rps = abs(float(msg.twist.twist.angular.z))
        out = deepcopy(msg)
        out.header.frame_id = self._odom_frame_id
        out.child_frame_id = self._base_link_frame_id
        self._odom_pub.publish(out)

    def _should_hold_gps(self) -> bool:
        return (
            self._gps_hold_when_stationary
            and self._gps_profile.name == "f9p_rtk"
            and self._last_gps_out is not None
            and self._last_odom_linear_speed_mps
            <= self._gps_hold_linear_speed_threshold_mps
            and self._last_odom_yaw_rate_rps <= self._gps_hold_yaw_rate_threshold_rps
        )


def main(args=None) -> None:
    rclpy.init(args=args)
    node = SimSensorNormalizerV2Node()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

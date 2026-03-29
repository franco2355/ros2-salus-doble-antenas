#!/usr/bin/env python3

from dataclasses import dataclass

import rclpy
from geometry_msgs.msg import TwistStamped
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu, NavSatFix


@dataclass
class TopicMonitor:
    label: str
    topic: str
    subscription: object
    last_rx_time_s: float | None = None
    missing_publisher_logged: bool = False
    stale_logged: bool = False


class MavrosCompatBridge(Node):
    def __init__(self) -> None:
        super().__init__("mavros_compat_bridge")

        self.declare_parameter("native_imu_topic", "/imu/data")
        self.declare_parameter("native_gps_topic", "/global_position/raw/fix")
        self.declare_parameter("native_odom_topic", "/local_position/odom")
        self.declare_parameter("native_velocity_topic", "/local_position/velocity_local")
        self.declare_parameter("legacy_gps_topic", "/gps/fix")
        self.declare_parameter("legacy_odom_topic", "/odom")
        self.declare_parameter("legacy_velocity_topic", "/velocity")
        self.declare_parameter("diagnostics_period_s", 5.0)
        self.declare_parameter("stale_timeout_s", 2.0)

        native_imu_topic = str(self.get_parameter("native_imu_topic").value)
        native_gps_topic = str(self.get_parameter("native_gps_topic").value)
        native_odom_topic = str(self.get_parameter("native_odom_topic").value)
        native_velocity_topic = str(self.get_parameter("native_velocity_topic").value)
        legacy_gps_topic = str(self.get_parameter("legacy_gps_topic").value)
        legacy_odom_topic = str(self.get_parameter("legacy_odom_topic").value)
        legacy_velocity_topic = str(self.get_parameter("legacy_velocity_topic").value)
        diagnostics_period_s = float(self.get_parameter("diagnostics_period_s").value)
        self._stale_timeout_s = float(self.get_parameter("stale_timeout_s").value)

        self._gps_pub = self.create_publisher(
            NavSatFix, legacy_gps_topic, qos_profile_sensor_data
        )
        self._odom_pub = self.create_publisher(
            Odometry, legacy_odom_topic, qos_profile_sensor_data
        )
        self._velocity_pub = self.create_publisher(
            TwistStamped, legacy_velocity_topic, qos_profile_sensor_data
        )

        imu_sub = self.create_subscription(
            Imu,
            native_imu_topic,
            self._imu_cb,
            qos_profile_sensor_data,
        )
        gps_sub = self.create_subscription(
            NavSatFix,
            native_gps_topic,
            self._gps_cb,
            qos_profile_sensor_data,
        )
        odom_sub = self.create_subscription(
            Odometry,
            native_odom_topic,
            self._odom_cb,
            qos_profile_sensor_data,
        )
        velocity_sub = self.create_subscription(
            TwistStamped,
            native_velocity_topic,
            self._velocity_cb,
            qos_profile_sensor_data,
        )

        self._monitors = {
            "imu": TopicMonitor("imu", native_imu_topic, imu_sub),
            "gps": TopicMonitor("gps", native_gps_topic, gps_sub),
            "odom": TopicMonitor("odom", native_odom_topic, odom_sub),
            "velocity": TopicMonitor("velocity", native_velocity_topic, velocity_sub),
        }
        self.create_timer(diagnostics_period_s, self._check_upstream_health)

        self.get_logger().info(
            "MAVROS compatibility bridge active: "
            f"{native_gps_topic} -> {legacy_gps_topic}, "
            f"{native_odom_topic} -> {legacy_odom_topic}, "
            f"{native_velocity_topic} -> {legacy_velocity_topic}"
        )

    def _now_s(self) -> float:
        return self.get_clock().now().nanoseconds / 1e9

    def _mark_rx(self, key: str) -> None:
        self._monitors[key].last_rx_time_s = self._now_s()

    def _imu_cb(self, _msg: Imu) -> None:
        self._mark_rx("imu")

    def _gps_cb(self, msg: NavSatFix) -> None:
        self._mark_rx("gps")
        self._gps_pub.publish(msg)

    def _odom_cb(self, msg: Odometry) -> None:
        self._mark_rx("odom")
        self._odom_pub.publish(msg)

    def _velocity_cb(self, msg: TwistStamped) -> None:
        self._mark_rx("velocity")
        self._velocity_pub.publish(msg)

    def _check_upstream_health(self) -> None:
        now_s = self._now_s()

        for monitor in self._monitors.values():
            publisher_count = self.count_publishers(monitor.topic)
            if publisher_count == 0:
                if not monitor.missing_publisher_logged:
                    self.get_logger().warning(
                        f"MAVROS upstream missing for {monitor.label}: waiting on {monitor.topic}"
                    )
                    monitor.missing_publisher_logged = True
                monitor.stale_logged = False
                continue

            if monitor.missing_publisher_logged:
                self.get_logger().info(
                    f"MAVROS upstream detected for {monitor.label}: {monitor.topic}"
                )
                monitor.missing_publisher_logged = False

            last_rx_time_s = monitor.last_rx_time_s
            if last_rx_time_s is None or (now_s - last_rx_time_s) > self._stale_timeout_s:
                if not monitor.stale_logged:
                    self.get_logger().warning(
                        "MAVROS upstream has publishers but no fresh messages for "
                        f"{monitor.label}: {monitor.topic}"
                    )
                    monitor.stale_logged = True
                continue

            if monitor.stale_logged:
                self.get_logger().info(
                    f"MAVROS upstream resumed for {monitor.label}: {monitor.topic}"
                )
                monitor.stale_logged = False


def main(args=None) -> None:
    rclpy.init(args=args)
    node = MavrosCompatBridge()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()

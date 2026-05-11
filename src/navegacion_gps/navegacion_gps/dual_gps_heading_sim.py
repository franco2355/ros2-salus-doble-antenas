import math

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node
from sensor_msgs.msg import Imu


def _normalize_angle(angle_rad: float) -> float:
    return math.atan2(math.sin(angle_rad), math.cos(angle_rad))


def _yaw_to_quaternion(yaw_rad: float) -> tuple[float, float, float, float]:
    half = yaw_rad / 2.0
    return 0.0, 0.0, math.sin(half), math.cos(half)


class DualGpsHeadingSim(Node):
    """Simulate ublox moving-baseline heading from ground-truth odometry."""

    def __init__(self) -> None:
        super().__init__("dual_gps_heading_sim")

        self.declare_parameter("odom_heading_topic", "/odom_raw")
        self.declare_parameter("output_topic", "/ublox_rover/navheading")
        self.declare_parameter("output_frame", "base_link")
        self.declare_parameter("raw_yaw_offset_rad", 0.0)
        self.declare_parameter("heading_covariance_rad2", 0.025)
        self.declare_parameter("max_hz", 20.0)

        self._odom_heading_topic = str(self.get_parameter("odom_heading_topic").value)
        self._output_topic = str(self.get_parameter("output_topic").value)
        self._output_frame = str(self.get_parameter("output_frame").value)
        self._raw_yaw_offset_rad = float(self.get_parameter("raw_yaw_offset_rad").value)
        self._heading_covariance_rad2 = float(
            self.get_parameter("heading_covariance_rad2").value
        )
        max_hz = max(1.0, float(self.get_parameter("max_hz").value))
        self._min_period_ns = int(1.0e9 / max_hz)
        self._last_pub_ns = 0

        self._publisher = self.create_publisher(Imu, self._output_topic, 10)
        self.create_subscription(Odometry, self._odom_heading_topic, self._on_odom, 10)

        self.get_logger().info(
            "dual_gps_heading_sim: "
            f"{self._odom_heading_topic} -> {self._output_topic} "
            f"(raw_offset={math.degrees(self._raw_yaw_offset_rad):.1f} deg)"
        )

    def _on_odom(self, msg: Odometry) -> None:
        stamp_ns = (int(msg.header.stamp.sec) * 1_000_000_000) + int(msg.header.stamp.nanosec)
        if self._last_pub_ns != 0 and (stamp_ns - self._last_pub_ns) < self._min_period_ns:
            return

        # In simulation we publish navheading in `base_link` for RViz/debug
        # visualization. Once the display is attached to `base_link`, the
        # orientation must represent only the sensor mounting offset relative
        # to the chassis, not the absolute world yaw from `/odom_raw`.
        raw_heading_rad = _normalize_angle(self._raw_yaw_offset_rad)
        ox, oy, oz, ow = _yaw_to_quaternion(raw_heading_rad)

        out = Imu()
        out.header.stamp = msg.header.stamp
        out.header.frame_id = self._output_frame
        out.orientation.x = ox
        out.orientation.y = oy
        out.orientation.z = oz
        out.orientation.w = ow
        out.orientation_covariance = [
            self._heading_covariance_rad2,
            0.0,
            0.0,
            0.0,
            self._heading_covariance_rad2,
            0.0,
            0.0,
            0.0,
            self._heading_covariance_rad2,
        ]
        out.angular_velocity_covariance[0] = -1.0
        out.linear_acceleration_covariance[0] = -1.0

        self._publisher.publish(out)
        self._last_pub_ns = stamp_ns


def main(args=None) -> None:
    rclpy.init(args=args)
    node = DualGpsHeadingSim()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()

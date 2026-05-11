import math

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Imu


_SENSOR_QOS = QoSProfile(
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
    depth=10,
)


def _normalize_angle(angle_rad: float) -> float:
    return math.atan2(math.sin(angle_rad), math.cos(angle_rad))


def _quat_to_yaw(x: float, y: float, z: float, w: float) -> float:
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def _yaw_to_quaternion(yaw_rad: float) -> tuple[float, float, float, float]:
    half = yaw_rad / 2.0
    return 0.0, 0.0, math.sin(half), math.cos(half)


class DualGpsHeadingReal(Node):
    def __init__(self) -> None:
        super().__init__("dual_gps_heading_real")

        self.declare_parameter("input_topic", "/ublox_rover/navheading")
        self.declare_parameter("output_topic", "/dual_gps/heading")
        # The real URDF models the dual antennas on the vehicle centerline
        # (front/rear), so the moving-baseline heading is expected to already
        # point along vehicle-forward yaw by default.
        self.declare_parameter("yaw_offset_rad", 0.0)
        self.declare_parameter("output_frame", "base_link")

        self._input_topic = str(self.get_parameter("input_topic").value)
        self._output_topic = str(self.get_parameter("output_topic").value)
        self._yaw_offset_rad = float(self.get_parameter("yaw_offset_rad").value)
        self._output_frame = str(self.get_parameter("output_frame").value)

        self._publisher = self.create_publisher(Imu, self._output_topic, _SENSOR_QOS)
        self.create_subscription(Imu, self._input_topic, self._on_heading, _SENSOR_QOS)

        self.get_logger().info(
            "dual_gps_heading_real: "
            f"{self._input_topic} -> {self._output_topic} "
            f"(offset={math.degrees(self._yaw_offset_rad):.1f} deg)"
        )

    def _on_heading(self, msg: Imu) -> None:
        yaw_rad = _quat_to_yaw(
            msg.orientation.x,
            msg.orientation.y,
            msg.orientation.z,
            msg.orientation.w,
        )
        corrected_yaw_rad = _normalize_angle(yaw_rad + self._yaw_offset_rad)
        ox, oy, oz, ow = _yaw_to_quaternion(corrected_yaw_rad)

        out = Imu()
        out.header.stamp = msg.header.stamp
        out.header.frame_id = self._output_frame
        out.orientation.x = ox
        out.orientation.y = oy
        out.orientation.z = oz
        out.orientation.w = ow
        out.orientation_covariance = list(msg.orientation_covariance)

        if msg.angular_velocity_covariance[0] >= 0.0:
            out.angular_velocity = msg.angular_velocity
            out.angular_velocity_covariance = list(msg.angular_velocity_covariance)
        else:
            out.angular_velocity_covariance[0] = -1.0

        if msg.linear_acceleration_covariance[0] >= 0.0:
            out.linear_acceleration = msg.linear_acceleration
            out.linear_acceleration_covariance = list(msg.linear_acceleration_covariance)
        else:
            out.linear_acceleration_covariance[0] = -1.0

        self._publisher.publish(out)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = DualGpsHeadingReal()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()

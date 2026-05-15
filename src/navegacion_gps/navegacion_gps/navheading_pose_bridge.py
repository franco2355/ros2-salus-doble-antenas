import rclpy
import rclpy.time
import tf2_ros
from geometry_msgs.msg import PoseStamped
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Imu


_SENSOR_QOS = QoSProfile(
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
    depth=10,
)


class NavheadingPoseBridge(Node):
    def __init__(self) -> None:
        super().__init__("navheading_pose_bridge")

        self.declare_parameter("input_topic", "/ublox_rover/navheading")
        self.declare_parameter("output_topic", "/ublox_rover/navheading_pose")
        self.declare_parameter("output_frame", "map")
        self.declare_parameter("robot_frame", "base_link")
        self.declare_parameter("offset_x", 0.0)
        self.declare_parameter("offset_y", 0.0)
        self.declare_parameter("offset_z", 0.6)

        self._input_topic = str(self.get_parameter("input_topic").value)
        self._output_topic = str(self.get_parameter("output_topic").value)
        self._output_frame = str(self.get_parameter("output_frame").value) or "map"
        self._robot_frame = str(self.get_parameter("robot_frame").value)
        self._offset_x = float(self.get_parameter("offset_x").value)
        self._offset_y = float(self.get_parameter("offset_y").value)
        self._offset_z = float(self.get_parameter("offset_z").value)

        self._tf_buffer = tf2_ros.Buffer()
        self._tf_listener = tf2_ros.TransformListener(self._tf_buffer, self)

        self._publisher = self.create_publisher(PoseStamped, self._output_topic, 10)
        self.create_subscription(Imu, self._input_topic, self._on_heading, _SENSOR_QOS)

        self.get_logger().info(
            "navheading_pose_bridge: "
            f"{self._input_topic} -> {self._output_topic} "
            f"(frame={self._output_frame}, robot_frame={self._robot_frame}, "
            f"offset=({self._offset_x:.2f}, {self._offset_y:.2f}, {self._offset_z:.2f}))"
        )

    def _on_heading(self, msg: Imu) -> None:
        out = PoseStamped()
        out.header.stamp = msg.header.stamp
        out.header.frame_id = str(msg.header.frame_id) or self._output_frame

        try:
            tf = self._tf_buffer.lookup_transform(
                out.header.frame_id,
                self._robot_frame,
                rclpy.time.Time(),
            )
            out.pose.position.x = tf.transform.translation.x + self._offset_x
            out.pose.position.y = tf.transform.translation.y + self._offset_y
            out.pose.position.z = tf.transform.translation.z + self._offset_z
        except Exception:
            # Publish a stable fallback pose while TF is still starting.
            out.pose.position.x = self._offset_x
            out.pose.position.y = self._offset_y
            out.pose.position.z = self._offset_z

        out.pose.orientation = msg.orientation
        self._publisher.publish(out)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = NavheadingPoseBridge()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()

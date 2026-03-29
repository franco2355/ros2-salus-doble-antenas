from geometry_msgs.msg import PolygonStamped
import rclpy
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
)


class PolygonStampedRepublisher(Node):
    def __init__(self) -> None:
        super().__init__("polygon_stamped_republisher")

        self.declare_parameter("input_topic", "/stop_zone_raw")
        self.declare_parameter("output_topic", "/stop_zone")
        self.declare_parameter("republish_period_s", 1.0)

        input_topic = str(self.get_parameter("input_topic").value)
        output_topic = str(self.get_parameter("output_topic").value)
        republish_period_s = float(self.get_parameter("republish_period_s").value)

        subscription_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=10,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE,
        )
        publication_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
        )

        self._latest_polygon: PolygonStamped | None = None
        self._publisher = self.create_publisher(
            PolygonStamped,
            output_topic,
            publication_qos,
        )
        self._subscription = self.create_subscription(
            PolygonStamped,
            input_topic,
            self._on_polygon,
            subscription_qos,
        )
        self._timer = self.create_timer(republish_period_s, self._republish_latest)

        self.get_logger().info(
            f"polygon_stamped_republisher ready ({input_topic} -> {output_topic}, "
            f"period={republish_period_s:.2f}s, transient_local=true)"
        )

    def _on_polygon(self, msg: PolygonStamped) -> None:
        self._latest_polygon = msg
        self._publisher.publish(msg)

    def _republish_latest(self) -> None:
        if self._latest_polygon is not None:
            self._publisher.publish(self._latest_polygon)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = PolygonStampedRepublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()

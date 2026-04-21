"""
lidar_brake_guard — publishes /fusion/brake_active using only /scan (LaserScan).

Use when no camera/YOLO is running but obstacle_recovery should still trigger.
Monitors the front sector and brakes when anything is within brake_distance_m.
"""

import math
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, HistoryPolicy
from sensor_msgs.msg import LaserScan
from std_msgs.msg import Bool


class LidarBrakeGuard(Node):
    def __init__(self) -> None:
        super().__init__('lidar_brake_guard')

        self.declare_parameter('scan_topic', '/scan')
        self.declare_parameter('brake_distance_m', 1.5)
        self.declare_parameter('front_half_angle_deg', 30.0)
        self.declare_parameter('min_range_m', 0.15)

        scan_topic = str(self.get_parameter('scan_topic').value)
        self._brake_dist = float(self.get_parameter('brake_distance_m').value)
        half_deg = float(self.get_parameter('front_half_angle_deg').value)
        self._half_angle = math.radians(half_deg)
        self._min_range = float(self.get_parameter('min_range_m').value)

        sensor_qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
            history=HistoryPolicy.KEEP_LAST,
            depth=5,
        )
        self._brake_pub = self.create_publisher(Bool, '/fusion/brake_active', 10)
        self.create_subscription(LaserScan, scan_topic, self._on_scan, sensor_qos)

        self.get_logger().info(
            f'lidar_brake_guard ready '
            f'(scan={scan_topic}, brake_dist={self._brake_dist}m, '
            f'front_sector=±{half_deg}°)'
        )

    def _on_scan(self, msg: LaserScan) -> None:
        obstacle = False
        angle = msg.angle_min
        for r in msg.ranges:
            if msg.angle_min <= angle <= msg.angle_max:
                if abs(angle) <= self._half_angle:
                    if self._min_range < r < self._brake_dist and math.isfinite(r):
                        obstacle = True
                        break
            angle += msg.angle_increment

        out = Bool()
        out.data = obstacle
        self._brake_pub.publish(out)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = LidarBrakeGuard()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()

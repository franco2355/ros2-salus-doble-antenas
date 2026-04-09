import math
from typing import List, Optional

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import LaserScan


def reduce_scan(
    msg: LaserScan,
    beam_stride: int,
    crop_angle_min_rad: float,
    crop_angle_max_rad: float,
    output_range_max_m: float,
) -> Optional[LaserScan]:
    if beam_stride < 1:
        beam_stride = 1
    if not msg.ranges:
        return None
    if not math.isfinite(msg.angle_increment) or abs(msg.angle_increment) < 1.0e-9:
        return None

    source_angle_min = float(msg.angle_min)
    source_angle_max = float(msg.angle_max)
    target_angle_min = max(source_angle_min, float(crop_angle_min_rad))
    target_angle_max = min(source_angle_max, float(crop_angle_max_rad))

    if target_angle_max < target_angle_min:
        return None

    start_index = max(
        0,
        int(math.ceil((target_angle_min - source_angle_min) / msg.angle_increment)),
    )
    end_index = min(
        len(msg.ranges) - 1,
        int(math.floor((target_angle_max - source_angle_min) / msg.angle_increment)),
    )

    if end_index < start_index:
        return None

    indices: List[int] = list(range(start_index, end_index + 1, beam_stride))
    if not indices:
        return None

    reduced = LaserScan()
    reduced.header = msg.header
    reduced.angle_min = source_angle_min + (indices[0] * msg.angle_increment)
    reduced.angle_max = source_angle_min + (indices[-1] * msg.angle_increment)
    reduced.angle_increment = msg.angle_increment * beam_stride
    reduced.time_increment = msg.time_increment * beam_stride
    reduced.scan_time = msg.scan_time
    reduced.range_min = msg.range_min
    reduced.range_max = min(float(msg.range_max), float(output_range_max_m))

    for index in indices:
        reading = float(msg.ranges[index])
        if math.isfinite(reading) and reading > reduced.range_max:
            reduced.ranges.append(float("inf"))
        else:
            reduced.ranges.append(reading)

    if len(msg.intensities) == len(msg.ranges):
        reduced.intensities = [float(msg.intensities[index]) for index in indices]

    return reduced


class ScanWifiDebugNode(Node):
    def __init__(self) -> None:
        super().__init__("scan_wifi_debug")

        self.declare_parameter("source_topic", "/scan")
        self.declare_parameter("output_topic", "/scan_wifi_debug")
        self.declare_parameter("publish_hz", 2.0)
        self.declare_parameter("beam_stride", 4)
        self.declare_parameter("crop_angle_min_rad", -1.57079632679)
        self.declare_parameter("crop_angle_max_rad", 1.57079632679)
        self.declare_parameter("output_range_max_m", 12.0)

        self._source_topic = str(self.get_parameter("source_topic").value)
        self._output_topic = str(self.get_parameter("output_topic").value)
        self._publish_hz = max(0.2, float(self.get_parameter("publish_hz").value))
        self._beam_stride = max(1, int(self.get_parameter("beam_stride").value))
        self._crop_angle_min_rad = float(self.get_parameter("crop_angle_min_rad").value)
        self._crop_angle_max_rad = float(self.get_parameter("crop_angle_max_rad").value)
        self._output_range_max_m = max(
            0.5, float(self.get_parameter("output_range_max_m").value)
        )
        self._min_publish_period_s = 1.0 / self._publish_hz
        self._last_publish_s = -1.0

        output_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        self._publisher = self.create_publisher(LaserScan, self._output_topic, output_qos)
        self._subscription = self.create_subscription(
            LaserScan,
            self._source_topic,
            self._on_scan,
            qos_profile_sensor_data,
        )

        self.get_logger().info(
            "scan_wifi_debug ready "
            f"(source={self._source_topic}, output={self._output_topic}, "
            f"publish_hz={self._publish_hz:.2f}, beam_stride={self._beam_stride}, "
            f"range_max={self._output_range_max_m:.1f}m)"
        )

    def _on_scan(self, msg: LaserScan) -> None:
        now_s = self.get_clock().now().nanoseconds / 1.0e9
        if self._last_publish_s >= 0.0 and (
            now_s - self._last_publish_s
        ) < self._min_publish_period_s:
            return

        reduced = reduce_scan(
            msg=msg,
            beam_stride=self._beam_stride,
            crop_angle_min_rad=self._crop_angle_min_rad,
            crop_angle_max_rad=self._crop_angle_max_rad,
            output_range_max_m=self._output_range_max_m,
        )
        if reduced is None:
            return

        self._publisher.publish(reduced)
        self._last_publish_s = now_s


def main(args=None) -> None:
    rclpy.init(args=args)
    node = ScanWifiDebugNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

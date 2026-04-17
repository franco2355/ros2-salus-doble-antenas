#!/usr/bin/env python3

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence, Tuple

import rclpy
from interfaces.msg import VisionTarget
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image
from vision_msgs.msg import Detection2DArray


@dataclass(frozen=True)
class SelectedTarget:
    detection_id: str
    label: str
    score: float
    center_x_px: float
    center_y_px: float
    width_px: float
    height_px: float
    image_width: int
    image_height: int

    @property
    def center_x_norm(self) -> float:
        if self.image_width <= 0:
            return 0.0
        return self.center_x_px / float(self.image_width)

    @property
    def center_y_norm(self) -> float:
        if self.image_height <= 0:
            return 0.0
        return self.center_y_px / float(self.image_height)

    @property
    def width_norm(self) -> float:
        if self.image_width <= 0:
            return 0.0
        return self.width_px / float(self.image_width)

    @property
    def height_norm(self) -> float:
        if self.image_height <= 0:
            return 0.0
        return self.height_px / float(self.image_height)


def _normalize_labels(labels: Iterable[str]) -> Tuple[str, ...]:
    normalized = []
    for raw in labels:
        label = str(raw).strip().lower()
        if label:
            normalized.append(label)
    return tuple(normalized)


def select_target(
    msg: Detection2DArray,
    *,
    preferred_labels: Sequence[str],
    min_score: float,
    fallback_to_any_label: bool,
    image_width: int,
    image_height: int,
) -> Optional[SelectedTarget]:
    preferred = _normalize_labels(preferred_labels)
    preferred_candidates: list[SelectedTarget] = []
    fallback_candidates: list[SelectedTarget] = []

    for detection in msg.detections:
        if not detection.results:
            continue
        hypothesis = detection.results[0].hypothesis
        label = str(hypothesis.class_id).strip()
        score = float(hypothesis.score)
        center_x_px = float(detection.bbox.center.position.x)
        center_y_px = float(detection.bbox.center.position.y)
        width_px = float(detection.bbox.size_x)
        height_px = float(detection.bbox.size_y)
        if (
            not math.isfinite(score)
            or score < min_score
            or not math.isfinite(center_x_px)
            or not math.isfinite(center_y_px)
            or not math.isfinite(width_px)
            or not math.isfinite(height_px)
            or width_px <= 0.0
            or height_px <= 0.0
        ):
            continue

        candidate = SelectedTarget(
            detection_id=str(detection.id),
            label=label,
            score=score,
            center_x_px=center_x_px,
            center_y_px=center_y_px,
            width_px=width_px,
            height_px=height_px,
            image_width=max(0, int(image_width)),
            image_height=max(0, int(image_height)),
        )
        fallback_candidates.append(candidate)
        if preferred and label.lower() in preferred:
            preferred_candidates.append(candidate)

    if preferred_candidates:
        return max(preferred_candidates, key=lambda candidate: candidate.score)
    if preferred and not fallback_to_any_label:
        return None
    if fallback_candidates:
        return max(fallback_candidates, key=lambda candidate: candidate.score)
    return None


class VisionTargetSelectorNode(Node):
    def __init__(self) -> None:
        super().__init__('vision_target_selector')

        self.declare_parameter('detections_topic', '/detections')
        self.declare_parameter('image_topic', '/camera/image_raw')
        self.declare_parameter('target_topic', '/vision/target')
        self.declare_parameter('publish_hz', 10.0)
        self.declare_parameter('detection_timeout_s', 0.35)
        self.declare_parameter('min_score', 0.40)
        self.declare_parameter('preferred_labels', [])
        self.declare_parameter('fallback_to_any_label', True)

        detections_topic = str(self.get_parameter('detections_topic').value)
        image_topic = str(self.get_parameter('image_topic').value)
        target_topic = str(self.get_parameter('target_topic').value)
        publish_hz = max(1.0, float(self.get_parameter('publish_hz').value))
        self._detection_timeout_s = max(
            0.05, float(self.get_parameter('detection_timeout_s').value)
        )
        self._min_score = float(self.get_parameter('min_score').value)
        self._preferred_labels = tuple(self.get_parameter('preferred_labels').value)
        self._fallback_to_any_label = bool(
            self.get_parameter('fallback_to_any_label').value
        )

        self._latest_image_width = 0
        self._latest_image_height = 0
        self._latest_detection_count = 0
        self._latest_target: Optional[SelectedTarget] = None
        self._latest_detection_stamp = None
        self._latest_detection_monotonic_s: Optional[float] = None

        self._target_pub = self.create_publisher(VisionTarget, target_topic, 10)
        self.create_subscription(Image, image_topic, self._on_image, qos_profile_sensor_data)
        self.create_subscription(Detection2DArray, detections_topic, self._on_detections, 10)
        self.create_timer(1.0 / publish_hz, self._publish_target)

        self.get_logger().info(
            'vision_target_selector ready '
            f'({detections_topic} -> {target_topic}, timeout={self._detection_timeout_s:.2f}s, '
            f'min_score={self._min_score:.2f}, preferred_labels={list(self._preferred_labels)})'
        )

    def _on_image(self, msg: Image) -> None:
        self._latest_image_width = max(0, int(msg.width))
        self._latest_image_height = max(0, int(msg.height))

    def _on_detections(self, msg: Detection2DArray) -> None:
        self._latest_detection_count = len(msg.detections)
        self._latest_detection_stamp = msg.header.stamp
        self._latest_detection_monotonic_s = time.monotonic()
        self._latest_target = select_target(
            msg,
            preferred_labels=self._preferred_labels,
            min_score=self._min_score,
            fallback_to_any_label=self._fallback_to_any_label,
            image_width=self._latest_image_width,
            image_height=self._latest_image_height,
        )

    def _publish_target(self) -> None:
        msg = VisionTarget()
        msg.age_s = -1.0
        msg.detection_count = int(self._latest_detection_count)
        if self._latest_detection_stamp is not None:
            msg.stamp = self._latest_detection_stamp

        if self._latest_detection_monotonic_s is None:
            self._target_pub.publish(msg)
            return

        age_s = max(0.0, time.monotonic() - self._latest_detection_monotonic_s)
        msg.age_s = age_s
        msg.fresh = age_s <= self._detection_timeout_s
        if not msg.fresh or self._latest_target is None:
            self._target_pub.publish(msg)
            return

        msg.available = True
        msg.detection_id = self._latest_target.detection_id
        msg.label = self._latest_target.label
        msg.score = float(self._latest_target.score)
        msg.image_width = int(self._latest_target.image_width)
        msg.image_height = int(self._latest_target.image_height)
        msg.center_x_px = float(self._latest_target.center_x_px)
        msg.center_y_px = float(self._latest_target.center_y_px)
        msg.width_px = float(self._latest_target.width_px)
        msg.height_px = float(self._latest_target.height_px)
        msg.center_x_norm = float(self._latest_target.center_x_norm)
        msg.center_y_norm = float(self._latest_target.center_y_norm)
        msg.width_norm = float(self._latest_target.width_norm)
        msg.height_norm = float(self._latest_target.height_norm)
        self._target_pub.publish(msg)


def main(args: Optional[Sequence[str]] = None) -> None:
    rclpy.init(args=args)
    node = VisionTargetSelectorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
vision_brake_guard — emergency brake triggered by the vision pipeline.

Flow:
  /vision/target  (interfaces/msg/VisionTarget)
      │
      ▼
  VisionBrakeGuardLogic  (navegacion_gps.vision_brake_guard_logic)
      │  trigger (rising edge, debounce + cooldown)
      ▼
  /nav_command_server/brake  (interfaces/srv/BrakeNav)

The guard reads navigation state from /nav_command_server/telemetry and is
active only when goal_active==True and manual_enabled==False (configurable).

Pure logic lives in vision_brake_guard_logic.py — importable without ROS.
"""
from __future__ import annotations

import json
import time
from typing import Any, Optional, Sequence

import rclpy
from interfaces.msg import NavTelemetry, VisionTarget
from interfaces.srv import BrakeNav
from rclpy.node import Node
from std_msgs.msg import String

from navegacion_gps.vision_brake_guard_logic import GuardInput, VisionBrakeGuardLogic


class VisionBrakeGuardNode(Node):
    """
    ROS 2 node that connects /vision/target to /nav_command_server/brake.

    Subscribes to:
      - /vision/target                    (interfaces/msg/VisionTarget)
      - /nav_command_server/telemetry     (interfaces/msg/NavTelemetry)

    Calls (async, non-blocking):
      - /nav_command_server/brake         (interfaces/srv/BrakeNav)

    Optionally publishes debug state:
      - /vision_brake_guard/state         (std_msgs/msg/String, JSON)
    """

    def __init__(self) -> None:
        super().__init__('vision_brake_guard')

        # -- parameters -------------------------------------------------------
        self.declare_parameter('target_topic', '/vision/target')
        self.declare_parameter('telemetry_topic', '/nav_command_server/telemetry')
        self.declare_parameter('brake_service', '/nav_command_server/brake')
        self.declare_parameter('trigger_labels', ['person'])
        self.declare_parameter('min_score', 0.60)
        self.declare_parameter('min_area_norm', 0.04)
        self.declare_parameter('required_consecutive_hits', 3)
        self.declare_parameter('retrigger_cooldown_s', 5.0)
        self.declare_parameter('enabled', True)
        self.declare_parameter('active_only_when_goal_active', True)
        self.declare_parameter('active_in_manual', False)
        self.declare_parameter('publish_debug_topic', False)

        target_topic = str(self.get_parameter('target_topic').value)
        telemetry_topic = str(self.get_parameter('telemetry_topic').value)
        brake_service = str(self.get_parameter('brake_service').value)
        trigger_labels = list(self.get_parameter('trigger_labels').value)
        min_score = float(self.get_parameter('min_score').value)
        min_area_norm = float(self.get_parameter('min_area_norm').value)
        required_consecutive_hits = int(self.get_parameter('required_consecutive_hits').value)
        retrigger_cooldown_s = float(self.get_parameter('retrigger_cooldown_s').value)
        enabled = bool(self.get_parameter('enabled').value)
        active_only_when_goal_active = bool(
            self.get_parameter('active_only_when_goal_active').value
        )
        active_in_manual = bool(self.get_parameter('active_in_manual').value)
        publish_debug = bool(self.get_parameter('publish_debug_topic').value)

        # -- logic ------------------------------------------------------------
        self._logic = VisionBrakeGuardLogic(
            trigger_labels=trigger_labels,
            min_score=min_score,
            min_area_norm=min_area_norm,
            required_consecutive_hits=required_consecutive_hits,
            retrigger_cooldown_s=retrigger_cooldown_s,
            enabled=enabled,
            active_only_when_goal_active=active_only_when_goal_active,
            active_in_manual=active_in_manual,
        )

        # -- nav state (updated from telemetry subscription) ------------------
        self._goal_active: bool = False
        self._manual_enabled: bool = False

        # -- at most one in-flight BrakeNav call at a time --------------------
        self._brake_future: Optional[Any] = None

        # -- ros i/o ----------------------------------------------------------
        self._brake_client = self.create_client(BrakeNav, brake_service)

        self.create_subscription(VisionTarget, target_topic, self._on_target, 10)
        self.create_subscription(NavTelemetry, telemetry_topic, self._on_telemetry, 10)

        self._debug_pub: Optional[Any] = None
        if publish_debug:
            self._debug_pub = self.create_publisher(String, '/vision_brake_guard/state', 10)

        self.get_logger().info(
            'vision_brake_guard ready — '
            f'target={target_topic}, brake={brake_service}, '
            f'labels={trigger_labels}, min_score={min_score:.2f}, '
            f'min_area_norm={min_area_norm:.4f}, hits={required_consecutive_hits}, '
            f'cooldown={retrigger_cooldown_s:.1f}s, enabled={enabled}, '
            f'goal_only={active_only_when_goal_active}'
        )

    # -- subscribers ----------------------------------------------------------

    def _on_telemetry(self, msg: NavTelemetry) -> None:
        self._goal_active = bool(msg.goal_active)
        self._manual_enabled = bool(msg.manual_enabled)

    def _on_target(self, msg: VisionTarget) -> None:
        area_norm = float(msg.width_norm) * float(msg.height_norm)

        inp = GuardInput(
            fresh=bool(msg.fresh),
            available=bool(msg.available),
            label=str(msg.label),
            score=float(msg.score),
            area_norm=area_norm,
            goal_active=self._goal_active,
            manual_enabled=self._manual_enabled,
        )

        if self._logic.update(inp, time.monotonic()):
            self._fire_brake()

        if self._debug_pub is not None:
            self._publish_debug(msg)

    # -- brake service call ---------------------------------------------------

    def _fire_brake(self) -> None:
        if not self._brake_client.service_is_ready():
            self.get_logger().warning(
                'vision_brake_guard: BrakeNav service not ready — brake skipped '
                f'(state={self._logic.state})'
            )
            return

        if self._brake_future is not None and not self._brake_future.done():
            self.get_logger().warning(
                'vision_brake_guard: BrakeNav call already in-flight — skip duplicate'
            )
            return

        self.get_logger().warning(
            'vision_brake_guard: FIRING EMERGENCY BRAKE '
            f'(state={self._logic.state}, hits={self._logic.hit_count}, '
            f'goal_active={self._goal_active})'
        )
        self._brake_future = self._brake_client.call_async(BrakeNav.Request())
        self._brake_future.add_done_callback(self._on_brake_done)

    def _on_brake_done(self, future: Any) -> None:
        try:
            resp = future.result()
            if resp.ok:
                self.get_logger().info('vision_brake_guard: BrakeNav responded OK')
            else:
                self.get_logger().error(
                    f'vision_brake_guard: BrakeNav responded error: {resp.error!r}'
                )
        except Exception as exc:
            self.get_logger().error(
                f'vision_brake_guard: BrakeNav call raised exception: {exc}'
            )

    # -- debug ----------------------------------------------------------------

    def _publish_debug(self, target_msg: VisionTarget) -> None:
        payload = {
            'state': self._logic.state,
            'hit_count': self._logic.hit_count,
            'goal_active': self._goal_active,
            'manual_enabled': self._manual_enabled,
            'target_fresh': bool(target_msg.fresh),
            'target_available': bool(target_msg.available),
            'target_label': str(target_msg.label),
            'target_score': round(float(target_msg.score), 4),
            'target_area_norm': round(
                float(target_msg.width_norm) * float(target_msg.height_norm), 6
            ),
        }
        msg = String()
        msg.data = json.dumps(payload, separators=(',', ':'))
        self._debug_pub.publish(msg)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(args: Optional[Sequence[str]] = None) -> None:
    rclpy.init(args=args)
    node = VisionBrakeGuardNode()
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

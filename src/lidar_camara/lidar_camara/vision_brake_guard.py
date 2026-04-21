#!/usr/bin/env python3
"""
vision_brake_guard.py — Capa de seguridad semántica visual.

Escucha /fusion/brake_active. Cuando recibe N frames consecutivos con True
(configurable: require_consecutive), llama al servicio /nav_command_server/brake
para detener la navegación autónoma.

El cooldown evita martillar el servicio. La lógica de N consecutivos filtra
falsos positivos de un solo frame ruidoso.

Separado de fusion_node para que pueda correr (o no) de forma independiente:
si el nav_command_server no está activo, el fusion_node sigue fusionando
y publicando /fusion/brake_active sin que este nodo crashee.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Optional, Sequence

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool, String

from interfaces.srv import BrakeNav


class VisionBrakeGuard(Node):
    def __init__(self) -> None:
        super().__init__('vision_brake_guard')

        self.declare_parameter('brake_service',      '/nav_command_server/brake')
        self.declare_parameter('brake_active_topic', '/fusion/brake_active')
        self.declare_parameter('cooldown_s',         3.0)
        self.declare_parameter('require_consecutive', 3)

        brake_service      = str(self.get_parameter('brake_service').value)
        brake_active_topic = str(self.get_parameter('brake_active_topic').value)
        self._cooldown     = float(self.get_parameter('cooldown_s').value)
        self._required     = int(self.get_parameter('require_consecutive').value)

        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        self._sub = self.create_subscription(
            Bool, brake_active_topic, self._on_brake_active, sensor_qos,
        )
        self._status_pub = self.create_publisher(String, '/fusion/brake_guard/status', 10)
        self._brake_client = self.create_client(BrakeNav, brake_service)

        self._consecutive: int = 0
        self._last_brake_monotonic: float = 0.0
        self._lock = threading.Lock()

        self.get_logger().info(
            f'vision_brake_guard listo '
            f'(servicio={brake_service}, cooldown={self._cooldown}s, '
            f'consecutivos={self._required})'
        )

    def _on_brake_active(self, msg: Bool) -> None:
        with self._lock:
            if msg.data:
                self._consecutive += 1
            else:
                self._consecutive = 0

            now = time.monotonic()
            should_brake = (
                self._consecutive >= self._required
                and now - self._last_brake_monotonic >= self._cooldown
                and self._brake_client.service_is_ready()
            )

            if should_brake:
                self._last_brake_monotonic = now
                self._consecutive = 0
                future = self._brake_client.call_async(BrakeNav.Request())
                future.add_done_callback(self._on_brake_response)
                self.get_logger().warn(
                    '[vision_brake_guard] BRAKE activado — objeto cercano confirmado por LiDAR+cámara'
                )

        self._status_pub.publish(String(data=json.dumps({
            'consecutive': self._consecutive,
            'brake_active': msg.data,
        })))

    def _on_brake_response(self, future) -> None:
        try:
            resp = future.result()
            if not resp.ok:
                self.get_logger().error(f'brake service error: {resp.error}')
        except Exception as exc:
            self.get_logger().error(f'brake call falló: {exc}')


def main(args=None) -> None:
    rclpy.init(args=args)
    node = VisionBrakeGuard()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

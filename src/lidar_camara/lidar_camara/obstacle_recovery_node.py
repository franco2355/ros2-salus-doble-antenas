#!/usr/bin/env python3
"""
obstacle_recovery_node.py — Secuencia de recuperación ante obstáculos semánticos.

Cuando /fusion/brake_active es True por `require_consecutive` frames:
  1. Activa modo manual en nav_command_server
  2. Retrocede a `backup_speed_mps` durante `backup_duration_s` segundos
  3. Desactiva modo manual
  4. Reenvía el último goal guardado en nav_command_server

El nodo publica en /cmd_vel_teleop (interfaces/CmdVelFinal) durante el retroceso.
El watchdog de nav_command_server requiere comandos cada < manual_cmd_timeout_s (0.4s),
por eso se publica a cmd_hz (default 10 Hz) durante toda la maniobra.

Máquina de estados:
  IDLE → [brake_active x N + cooldown OK] → BACKING_UP → [duración] → RESUMING → IDLE
"""
from __future__ import annotations

import enum
import json
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool, String
from std_srvs.srv import Trigger

from interfaces.msg import CmdVelFinal
from interfaces.srv import SetManualMode


class State(enum.Enum):
    IDLE        = "idle"
    BACKING_UP  = "backing_up"
    RESUMING    = "resuming"


class ObstacleRecoveryNode(Node):
    def __init__(self) -> None:
        super().__init__('obstacle_recovery')

        # ── parámetros ───────────────────────────────────────────────────
        self.declare_parameter('brake_active_topic',      '/fusion/brake_active')
        self.declare_parameter('teleop_topic',            '/cmd_vel_teleop')
        self.declare_parameter('set_manual_mode_service', '/nav_command_server/set_manual_mode')
        self.declare_parameter('resume_last_goal_service','/nav_command_server/resume_last_goal')
        self.declare_parameter('require_consecutive',     3)
        self.declare_parameter('backup_speed_mps',        0.3)
        self.declare_parameter('backup_duration_s',       2.0)
        self.declare_parameter('cooldown_s',              6.0)
        self.declare_parameter('cmd_hz',                  10.0)

        brake_topic    = str(self.get_parameter('brake_active_topic').value)
        teleop_topic   = str(self.get_parameter('teleop_topic').value)
        manual_svc     = str(self.get_parameter('set_manual_mode_service').value)
        resume_svc     = str(self.get_parameter('resume_last_goal_service').value)
        self._required = int(self.get_parameter('require_consecutive').value)
        self._bk_speed = float(self.get_parameter('backup_speed_mps').value)
        self._bk_dur   = float(self.get_parameter('backup_duration_s').value)
        self._cooldown = float(self.get_parameter('cooldown_s').value)
        self._cmd_hz   = float(self.get_parameter('cmd_hz').value)

        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        self._brake_sub  = self.create_subscription(
            Bool, brake_topic, self._on_brake_active, sensor_qos,
        )
        self._teleop_pub = self.create_publisher(CmdVelFinal, teleop_topic, 10)
        self._status_pub = self.create_publisher(String, '/fusion/recovery/status', 10)
        self._manual_cli = self.create_client(SetManualMode, manual_svc)
        self._resume_cli = self.create_client(Trigger, resume_svc)

        self._state       = State.IDLE
        self._consecutive = 0
        self._last_recovery_t = 0.0
        self._lock = threading.Lock()

        self.get_logger().info(
            f'obstacle_recovery listo — '
            f'backup={self._bk_speed}m/s x {self._bk_dur}s, '
            f'cooldown={self._cooldown}s, consecutivos_req={self._required}, '
            f'resume_service={resume_svc}'
        )

    # ── callback ─────────────────────────────────────────────────────────

    def _on_brake_active(self, msg: Bool) -> None:
        with self._lock:
            if self._state != State.IDLE:
                return  # ya hay una recuperación en curso

            if msg.data:
                self._consecutive += 1
            else:
                self._consecutive = 0
                return

            now = time.monotonic()
            ready = (
                self._consecutive >= self._required
                and now - self._last_recovery_t >= self._cooldown
            )
            if not ready:
                return

            self._consecutive = 0
            self._last_recovery_t = now
            self._state = State.BACKING_UP

        # Lanza la secuencia en un thread para no bloquear el executor
        threading.Thread(target=self._recovery_sequence, daemon=True).start()
        self._publish_status()

    # ── secuencia de recuperación ─────────────────────────────────────────

    def _recovery_sequence(self) -> None:
        self.get_logger().warn(
            '[obstacle_recovery] obstáculo confirmado — '
            f'activando manual, retrocediendo {self._bk_dur}s a {self._bk_speed}m/s'
        )

        # 1. Activar modo manual
        if not self._set_manual_mode(True):
            self.get_logger().error(
                '[obstacle_recovery] set_manual_mode(True) falló — abortando'
            )
            with self._lock:
                self._state = State.IDLE
            self._publish_status()
            return

        # 2. Retroceder
        period = 1.0 / self._cmd_hz
        t_end  = time.monotonic() + self._bk_dur
        while time.monotonic() < t_end:
            self._pub_teleop(-self._bk_speed, 0.0)
            time.sleep(period)

        # 3. Frenar en el lugar un instante
        for _ in range(3):
            self._pub_teleop(0.0, 0.0, brake_pct=100)
            time.sleep(period)

        # 4. Retomar navegación autónoma
        with self._lock:
            self._state = State.RESUMING
        self._publish_status()

        self.get_logger().info(
            '[obstacle_recovery] desactivando manual y reanudando el último goal'
        )

        if not self._set_manual_mode(False):
            self.get_logger().error(
                '[obstacle_recovery] set_manual_mode(False) falló — '
                'robot puede quedar en manual, verificar manualmente'
            )
        elif not self._resume_last_goal():
            self.get_logger().warning(
                '[obstacle_recovery] no se pudo reanudar el último goal; '
                'Nav2 quedó sin objetivo activo'
            )

        with self._lock:
            self._state = State.IDLE
        self._publish_status()
        self.get_logger().info('[obstacle_recovery] recuperación completada')

    # ── helpers ──────────────────────────────────────────────────────────

    def _pub_teleop(self, linear_x: float, angular_z: float, brake_pct: int = 0) -> None:
        cmd = CmdVelFinal()
        cmd.twist.linear.x  = float(linear_x)
        cmd.twist.angular.z = float(angular_z)
        cmd.brake_pct = max(0, min(100, brake_pct))
        self._teleop_pub.publish(cmd)

    def _set_manual_mode(self, enabled: bool, timeout_s: float = 3.0) -> bool:
        if not self._manual_cli.wait_for_service(timeout_sec=2.0):
            self.get_logger().error(
                f'[obstacle_recovery] servicio {self._manual_cli.srv_name} no disponible'
            )
            return False

        req = SetManualMode.Request()
        req.enabled = enabled
        future = self._manual_cli.call_async(req)

        # Esperar en el thread background (el executor de ROS 2 procesa el future)
        t0 = time.monotonic()
        while not future.done():
            if time.monotonic() - t0 > timeout_s:
                self.get_logger().error('[obstacle_recovery] timeout esperando set_manual_mode')
                return False
            time.sleep(0.05)

        result = future.result()
        if result is None or not result.ok:
            err = result.error if result else 'sin respuesta'
            self.get_logger().error(f'[obstacle_recovery] set_manual_mode({enabled}) error: {err}')
            return False
        return True

    def _resume_last_goal(self, timeout_s: float = 5.0) -> bool:
        if not self._resume_cli.wait_for_service(timeout_sec=2.0):
            self.get_logger().error(
                f'[obstacle_recovery] servicio {self._resume_cli.srv_name} no disponible'
            )
            return False

        future = self._resume_cli.call_async(Trigger.Request())
        t0 = time.monotonic()
        while not future.done():
            if time.monotonic() - t0 > timeout_s:
                self.get_logger().error('[obstacle_recovery] timeout esperando resume_last_goal')
                return False
            time.sleep(0.05)

        result = future.result()
        if result is None or not result.success:
            err = result.message if result else 'sin respuesta'
            self.get_logger().error(f'[obstacle_recovery] resume_last_goal error: {err}')
            return False

        self.get_logger().info(
            f'[obstacle_recovery] resume_last_goal OK: {result.message}'
        )
        return True

    def _publish_status(self) -> None:
        with self._lock:
            state = self._state.value
            consec = self._consecutive
        self._status_pub.publish(String(data=json.dumps({
            'state': state,
            'consecutive': consec,
        })))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = ObstacleRecoveryNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

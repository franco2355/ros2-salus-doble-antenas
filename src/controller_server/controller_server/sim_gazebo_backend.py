from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Optional

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rclpy.node import Node
from sensor_msgs.msg import JointState

from controller_server.rpy_esp32_comms.controller import CommandState
from controller_server.rpy_esp32_comms.telemetry import ControlSource, Telemetry
from controller_server.rpy_esp32_comms.transport import CommsStats
from controller_server.control_logic import DesiredCommand


DEFAULT_SIM_WHEELBASE_M = 0.94
DEFAULT_ODOM_STEER_MIN_SPEED_MPS = 0.05


@dataclass(slots=True)
class OdomSample:
    linear_x_mps: float
    linear_y_mps: float
    angular_z_rps: float
    rx_monotonic_s: float


def translate_command_state_to_gazebo_twist(
    *,
    command_state: CommandState,
    max_steering_angle_rad: float,
    invert_actuation_steer_sign: bool,
) -> tuple[float, float]:
    if (not bool(command_state.drive_enabled)) or bool(command_state.estop):
        return (0.0, 0.0)
    if int(command_state.brake_pct) > 0:
        return (0.0, 0.0)

    steering_angle_rad = (
        float(command_state.steer_pct) / 100.0 * abs(float(max_steering_angle_rad))
    )
    if bool(invert_actuation_steer_sign):
        steering_angle_rad = -steering_angle_rad
    return (float(command_state.speed_mps), steering_angle_rad)


def select_physical_steering_angle_rad(
    *,
    joint_angle_rad: Optional[float],
    odom_linear_x_mps: Optional[float],
    odom_angular_z_rps: Optional[float],
    wheelbase_m: float = DEFAULT_SIM_WHEELBASE_M,
    min_speed_mps: float = DEFAULT_ODOM_STEER_MIN_SPEED_MPS,
) -> Optional[float]:
    if joint_angle_rad is not None and math.isfinite(float(joint_angle_rad)):
        return float(joint_angle_rad)
    if odom_linear_x_mps is None or odom_angular_z_rps is None:
        return None

    signed_speed_mps = float(odom_linear_x_mps)
    if abs(signed_speed_mps) < max(0.0, float(min_speed_mps)):
        return None
    if abs(float(wheelbase_m)) < 1.0e-6:
        return None
    return math.atan2(float(wheelbase_m) * float(odom_angular_z_rps), signed_speed_mps)


def build_status_flags(
    *,
    ready: bool,
    estop_active: bool,
    pi_fresh: bool,
    control_source: ControlSource,
    failsafe_active: bool = False,
    overspeed_active: bool = False,
) -> int:
    flags = 0
    if bool(ready):
        flags |= 1 << 0
    if bool(estop_active):
        flags |= 1 << 1
    if bool(failsafe_active):
        flags |= 1 << 2
    if bool(pi_fresh):
        flags |= 1 << 3
    flags |= (int(control_source) & 0x03) << 4
    if bool(overspeed_active):
        flags |= 1 << 6
    return flags


def synthesize_telemetry(
    *,
    command_state: CommandState,
    odom_sample: Optional[OdomSample],
    joint_angle_rad: Optional[float],
    invert_measured_steer_sign: bool,
    telemetry_timeout_s: float,
) -> Optional[Telemetry]:
    rx_monotonic_s = (
        float(odom_sample.rx_monotonic_s) if odom_sample is not None else time.monotonic()
    )
    ready = odom_sample is not None
    now_s = time.monotonic()
    pi_fresh = bool(ready) and ((now_s - rx_monotonic_s) <= max(0.05, float(telemetry_timeout_s)))

    if bool(command_state.drive_enabled) and bool(pi_fresh):
        control_source = ControlSource.PI
    else:
        control_source = ControlSource.NONE

    speed_mps = None
    steering_angle_rad = None
    if odom_sample is not None:
        speed_mps = math.hypot(
            float(odom_sample.linear_x_mps),
            float(odom_sample.linear_y_mps),
        )
        steering_angle_rad = select_physical_steering_angle_rad(
            joint_angle_rad=joint_angle_rad,
            odom_linear_x_mps=odom_sample.linear_x_mps,
            odom_angular_z_rps=odom_sample.angular_z_rps,
        )

    steer_deg = None
    if steering_angle_rad is not None and math.isfinite(float(steering_angle_rad)):
        steer_deg = math.degrees(float(steering_angle_rad))
        if bool(invert_measured_steer_sign):
            steer_deg = -steer_deg

    brake_applied_pct = int(command_state.brake_pct) if int(command_state.brake_pct) > 0 else 0
    status_flags = build_status_flags(
        ready=ready,
        estop_active=bool(command_state.estop) or brake_applied_pct > 0,
        pi_fresh=pi_fresh,
        control_source=control_source,
    )

    return Telemetry(
        status_flags=status_flags,
        speed_mps=float(speed_mps) if speed_mps is not None else None,
        steer_deg=float(steer_deg) if steer_deg is not None else None,
        brake_applied_pct=brake_applied_pct,
        raw_speed_centi_mps=int(round(float(speed_mps) * 100.0)) if speed_mps is not None else 0,
        raw_steer_centi_deg=int(round(float(steer_deg) * 100.0)) if steer_deg is not None else 0,
        rx_monotonic_s=rx_monotonic_s,
    )


class SimGazeboBackend:
    def __init__(
        self,
        *,
        node: Node,
        tx_hz: float,
        max_speed_mps: float,
        max_reverse_mps: float,
        cmd_vel_topic: str,
        odom_topic: str,
        joint_states_topic: str,
        front_left_steer_joint: str,
        front_right_steer_joint: str,
        max_steering_angle_rad: float,
        telemetry_timeout_s: float,
        invert_actuation_steer_sign: bool,
        invert_measured_steer_sign: bool,
    ) -> None:
        self._node = node
        self._tx_period_s = 1.0 / max(1.0, float(tx_hz))
        self._telemetry_timeout_s = max(0.05, float(telemetry_timeout_s))
        self._front_left_steer_joint = str(front_left_steer_joint)
        self._front_right_steer_joint = str(front_right_steer_joint)
        self._max_steering_angle_rad = abs(float(max_steering_angle_rad))
        self._invert_actuation_steer_sign = bool(invert_actuation_steer_sign)
        self._invert_measured_steer_sign = bool(invert_measured_steer_sign)

        self._state_lock = threading.Lock()
        self._state = CommandState(
            max_speed_mps=float(max_speed_mps),
            max_reverse_mps=float(max_reverse_mps),
        )
        self._latest_odom: Optional[OdomSample] = None
        self._latest_joint_angle_rad: Optional[float] = None
        self._stats = CommsStats()
        self._running = False

        self._pub = self._node.create_publisher(Twist, str(cmd_vel_topic), 10)
        self._node.create_subscription(Odometry, str(odom_topic), self._on_odom, 10)
        self._node.create_subscription(
            JointState, str(joint_states_topic), self._on_joint_states, 10
        )
        self._timer = self._node.create_timer(self._tx_period_s, self._publish_current_command)

    def start(self) -> None:
        with self._state_lock:
            self._state.safe_reset()
        self._running = True

    def stop(self) -> None:
        with self._state_lock:
            self._state.safe_reset()
            self._running = False
        self._pub.publish(Twist())
        self._pub.publish(Twist())

    def apply_command(self, cmd: DesiredCommand) -> None:
        with self._state_lock:
            self._state.set_drive_enabled(bool(cmd.drive_enabled))
            self._state.set_estop(bool(cmd.estop))
            self._state.set_speed_mps(float(cmd.speed_mps))
            self._state.set_steer_pct(int(cmd.steer_pct))
            self._state.set_brake_pct(int(cmd.brake_pct))

    def get_latest_telemetry(self) -> Optional[Telemetry]:
        with self._state_lock:
            command_state = CommandState(**self._state.to_dict())
            odom_sample = self._latest_odom
            joint_angle_rad = self._latest_joint_angle_rad
        return synthesize_telemetry(
            command_state=command_state,
            odom_sample=odom_sample,
            joint_angle_rad=joint_angle_rad,
            invert_measured_steer_sign=self._invert_measured_steer_sign,
            telemetry_timeout_s=self._telemetry_timeout_s,
        )

    def get_command_state(self) -> dict:
        with self._state_lock:
            return self._state.to_dict()

    def get_stats(self) -> CommsStats:
        with self._state_lock:
            return CommsStats(
                tx_frames_ok=self._stats.tx_frames_ok,
                tx_errors=self._stats.tx_errors,
                rx_frames_ok=self._stats.rx_frames_ok,
                rx_crc_errors=self._stats.rx_crc_errors,
                rx_parse_drops=self._stats.rx_parse_drops,
            )

    def _on_odom(self, msg: Odometry) -> None:
        sample = OdomSample(
            linear_x_mps=float(msg.twist.twist.linear.x),
            linear_y_mps=float(msg.twist.twist.linear.y),
            angular_z_rps=float(msg.twist.twist.angular.z),
            rx_monotonic_s=time.monotonic(),
        )
        with self._state_lock:
            self._latest_odom = sample
            self._stats.rx_frames_ok += 1

    def _on_joint_states(self, msg: JointState) -> None:
        positions_by_name = dict(zip(msg.name, msg.position))
        steer_samples = []
        for joint_name in (
            self._front_left_steer_joint,
            self._front_right_steer_joint,
        ):
            if joint_name in positions_by_name:
                steer_samples.append(float(positions_by_name[joint_name]))
        if not steer_samples:
            return
        with self._state_lock:
            self._latest_joint_angle_rad = sum(steer_samples) / float(len(steer_samples))

    def _publish_current_command(self) -> None:
        with self._state_lock:
            if not self._running:
                return
            command_state = CommandState(**self._state.to_dict())
        out = Twist()
        out.linear.x, out.angular.z = translate_command_state_to_gazebo_twist(
            command_state=command_state,
            max_steering_angle_rad=self._max_steering_angle_rad,
            invert_actuation_steer_sign=self._invert_actuation_steer_sign,
        )
        self._pub.publish(out)
        with self._state_lock:
            self._stats.tx_frames_ok += 1

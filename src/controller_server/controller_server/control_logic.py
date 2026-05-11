from __future__ import annotations

import math
from dataclasses import dataclass


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass(slots=True)
class DesiredCommand:
    drive_enabled: bool = False
    estop: bool = False
    speed_mps: float = 0.0
    steer_pct: int = 0
    brake_pct: int = 0
    requested_linear_x_mps: float = 0.0
    requested_angular_z_rps: float = 0.0
    steering_reference_speed_mps: float = 0.0
    requested_curvature_inv_m: float = 0.0
    applied_curvature_inv_m: float = 0.0
    requested_steer_rad: float = 0.0
    applied_steer_rad: float = 0.0
    steer_saturated: bool = False
    used_steering_speed_fallback: bool = False
    speed_limited: bool = False
    min_speed_enforced: bool = False


@dataclass(slots=True)
class ArbitrationResult:
    command: DesiredCommand
    source: str
    fresh: bool


@dataclass(slots=True)
class ReverseTransitionState:
    request_latched: bool = False
    brake_active: bool = False
    brake_started_s: float = 0.0


def safe_command() -> DesiredCommand:
    return DesiredCommand(
        drive_enabled=False,
        estop=False,
        speed_mps=0.0,
        steer_pct=0,
        brake_pct=0,
    )


def _compute_ackermann_steer_command(
    *,
    linear_x: float,
    angular_z: float,
    vx_deadband_mps: float,
    vx_min_effective_mps: float,
    wheelbase_m: float,
    steering_limit_rad: float,
) -> tuple[int, float, float, float, float, float, bool, bool]:
    wheelbase = max(1.0e-6, abs(float(wheelbase_m)))
    steering_limit = max(1.0e-6, abs(float(steering_limit_rad)))
    deadband = max(0.0, float(vx_deadband_mps))
    min_effective = max(0.0, float(vx_min_effective_mps))
    requested_linear = float(linear_x)
    requested_angular = float(angular_z)

    used_speed_fallback = False
    reference_speed = requested_linear
    if abs(reference_speed) <= max(1.0e-6, deadband):
        if abs(requested_angular) <= 1.0e-6:
            return (0, 0.0, 0.0, 0.0, 0.0, 0.0, False, False)
        reference_speed = max(min_effective, 0.1)
        used_speed_fallback = True

    requested_curvature = requested_angular / reference_speed
    requested_steer_rad = math.atan(wheelbase * requested_curvature)
    applied_steer_rad = clamp(requested_steer_rad, -steering_limit, steering_limit)
    applied_curvature = math.tan(applied_steer_rad) / wheelbase
    steer_saturated = abs(requested_steer_rad - applied_steer_rad) > 1.0e-6
    steer_pct = int(round((applied_steer_rad / steering_limit) * 100.0))
    steer_pct = int(clamp(float(steer_pct), -100.0, 100.0))

    return (
        steer_pct,
        reference_speed,
        requested_curvature,
        applied_curvature,
        requested_steer_rad,
        applied_steer_rad,
        steer_saturated,
        used_speed_fallback,
    )


def command_from_cmd_vel(
    linear_x: float,
    angular_z: float,
    brake_pct: int,
    max_speed_mps: float,
    max_reverse_mps: float,
    vx_deadband_mps: float,
    vx_min_effective_mps: float,
    max_abs_angular_z: float,
    wheelbase_m: float,
    steering_limit_rad: float,
    invert_steer: bool,
    auto_drive_enabled: bool,
    reverse_brake_pct: int,
) -> DesiredCommand:
    max_speed = max(0.0, float(max_speed_mps))
    max_reverse = max(0.0, float(max_reverse_mps))
    deadband = max(0.0, float(vx_deadband_mps))
    min_effective = clamp(float(vx_min_effective_mps), 0.0, max_speed)
    angular_limit = max(0.0, abs(float(max_abs_angular_z)))

    linear = float(linear_x)
    angular = float(angular_z)
    if angular_limit <= 1.0e-6:
        angular = 0.0
    else:
        angular = clamp(angular, -angular_limit, angular_limit)
    speed = 0.0
    speed_limited = False
    min_speed_enforced = False
    if linear > 0.0:
        requested_speed = clamp(linear, 0.0, max_speed)
        speed_limited = abs(requested_speed - linear) > 1.0e-6
        speed = requested_speed
        if speed < deadband:
            speed = 0.0
        elif speed < min_effective:
            speed = min_effective
            min_speed_enforced = requested_speed > 1.0e-6
    elif linear < 0.0:
        reverse_speed = clamp(abs(linear), 0.0, max_reverse)
        speed_limited = abs(reverse_speed - abs(linear)) > 1.0e-6
        if reverse_speed < deadband:
            speed = 0.0
        else:
            speed = -reverse_speed

    (
        steer,
        steering_reference_speed_mps,
        requested_curvature,
        applied_curvature,
        requested_steer_rad,
        applied_steer_rad,
        steer_saturated,
        used_steering_speed_fallback,
    ) = _compute_ackermann_steer_command(
        linear_x=linear,
        angular_z=angular,
        vx_deadband_mps=deadband,
        vx_min_effective_mps=min_effective,
        wheelbase_m=wheelbase_m,
        steering_limit_rad=steering_limit_rad,
    )
    if bool(invert_steer):
        steer = -steer

    brake = int(clamp(float(brake_pct), 0.0, 100.0))
    estop = brake > 0
    if estop:
        speed = 0.0
        steer = 0

    return DesiredCommand(
        drive_enabled=bool(auto_drive_enabled),
        estop=estop,
        speed_mps=speed,
        steer_pct=steer,
        brake_pct=brake,
        requested_linear_x_mps=linear,
        requested_angular_z_rps=angular,
        steering_reference_speed_mps=steering_reference_speed_mps,
        requested_curvature_inv_m=requested_curvature,
        applied_curvature_inv_m=applied_curvature,
        requested_steer_rad=requested_steer_rad,
        applied_steer_rad=applied_steer_rad,
        steer_saturated=steer_saturated,
        used_steering_speed_fallback=used_steering_speed_fallback,
        speed_limited=speed_limited,
        min_speed_enforced=min_speed_enforced,
    )


def select_effective_command(
    now_s: float,
    auto_cmd: DesiredCommand,
    auto_stamp_s: float,
    auto_timeout_s: float,
) -> ArbitrationResult:
    auto_fresh = (now_s - auto_stamp_s) <= max(0.0, auto_timeout_s)

    if auto_fresh:
        return ArbitrationResult(command=auto_cmd, source="auto", fresh=True)
    return ArbitrationResult(command=safe_command(), source="auto_timeout", fresh=False)


def is_reverse_requested(
    cmd: DesiredCommand,
    *,
    speed_epsilon_mps: float = 1.0e-3,
) -> bool:
    return (not bool(cmd.estop)) and float(cmd.speed_mps) < -abs(float(speed_epsilon_mps))


def build_reverse_transition_command(
    cmd: DesiredCommand,
    *,
    reverse_brake_pct: int,
) -> DesiredCommand:
    brake_pct = int(clamp(float(reverse_brake_pct), 0.0, 100.0))
    if brake_pct <= 0:
        return cmd
    return DesiredCommand(
        drive_enabled=bool(cmd.drive_enabled),
        estop=False,
        speed_mps=0.0,
        steer_pct=0,
        brake_pct=brake_pct,
        requested_linear_x_mps=cmd.requested_linear_x_mps,
        requested_angular_z_rps=cmd.requested_angular_z_rps,
        steering_reference_speed_mps=cmd.steering_reference_speed_mps,
        requested_curvature_inv_m=cmd.requested_curvature_inv_m,
        applied_curvature_inv_m=0.0,
        requested_steer_rad=cmd.requested_steer_rad,
        applied_steer_rad=0.0,
        steer_saturated=False,
        used_steering_speed_fallback=cmd.used_steering_speed_fallback,
        speed_limited=cmd.speed_limited,
        min_speed_enforced=cmd.min_speed_enforced,
    )


def reverse_transition_complete(
    *,
    now_s: float,
    started_s: float,
    min_hold_s: float,
    measured_speed_mps: float | None,
    telemetry_fresh: bool,
    stop_speed_threshold_mps: float,
) -> bool:
    if (float(now_s) - float(started_s)) < max(0.0, float(min_hold_s)):
        return False
    if bool(telemetry_fresh) and measured_speed_mps is not None:
        return abs(float(measured_speed_mps)) <= max(0.0, float(stop_speed_threshold_mps))
    return True


def apply_reverse_transition(
    *,
    now_s: float,
    cmd: DesiredCommand,
    source: str,
    state: ReverseTransitionState,
    reverse_brake_pct: int,
    min_hold_s: float,
    measured_speed_mps: float | None,
    telemetry_fresh: bool,
    stop_speed_threshold_mps: float,
) -> tuple[DesiredCommand, str, ReverseTransitionState]:
    if reverse_brake_pct <= 0 or (not is_reverse_requested(cmd)):
        return cmd, source, ReverseTransitionState()

    request_latched = bool(state.request_latched)
    brake_active = bool(state.brake_active)
    brake_started_s = float(state.brake_started_s)

    if (not request_latched) and (not brake_active):
        brake_active = True
        brake_started_s = float(now_s)

    if brake_active:
        if not reverse_transition_complete(
            now_s=now_s,
            started_s=brake_started_s,
            min_hold_s=min_hold_s,
            measured_speed_mps=measured_speed_mps,
            telemetry_fresh=telemetry_fresh,
            stop_speed_threshold_mps=stop_speed_threshold_mps,
        ):
            return (
                build_reverse_transition_command(
                    cmd,
                    reverse_brake_pct=reverse_brake_pct,
                ),
                "reverse_brake_transition",
                ReverseTransitionState(
                    request_latched=True,
                    brake_active=True,
                    brake_started_s=brake_started_s,
                ),
            )
        brake_active = False

    return (
        cmd,
        source,
        ReverseTransitionState(
            request_latched=True,
            brake_active=brake_active,
            brake_started_s=brake_started_s,
        ),
    )

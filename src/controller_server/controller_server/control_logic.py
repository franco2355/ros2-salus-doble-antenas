from __future__ import annotations

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


@dataclass(slots=True)
class ArbitrationResult:
    command: DesiredCommand
    source: str
    fresh: bool


def safe_command() -> DesiredCommand:
    return DesiredCommand(
        drive_enabled=False,
        estop=False,
        speed_mps=0.0,
        steer_pct=0,
        brake_pct=0,
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
    invert_steer: bool,
    auto_drive_enabled: bool,
    reverse_brake_pct: int,
) -> DesiredCommand:
    max_speed = max(0.0, float(max_speed_mps))
    max_reverse = max(0.0, float(max_reverse_mps))
    deadband = max(0.0, float(vx_deadband_mps))
    min_effective = clamp(float(vx_min_effective_mps), 0.0, max_speed)

    linear = float(linear_x)
    steer_angular = float(angular_z)
    speed = 0.0
    if linear > 0.0:
        requested_speed = clamp(linear, 0.0, max_speed)
        speed = requested_speed
        if speed < deadband:
            speed = 0.0
        elif speed < min_effective:
            if requested_speed > 1.0e-6:
                steer_angular *= min_effective / requested_speed
            speed = min_effective
    elif linear < 0.0:
        reverse_speed = clamp(abs(linear), 0.0, max_reverse)
        if reverse_speed < deadband:
            speed = 0.0
        else:
            speed = -reverse_speed

    steer = 0
    angular_scale = max(0.01, abs(float(max_abs_angular_z)))
    steer_ratio = clamp(steer_angular / angular_scale, -1.0, 1.0)
    steer = int(round(steer_ratio * 100.0))
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

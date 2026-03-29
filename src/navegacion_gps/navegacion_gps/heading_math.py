from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional


def normalize_yaw_deg(yaw_deg: float) -> float:
    yaw = float(yaw_deg)
    while yaw <= -180.0:
        yaw += 360.0
    while yaw > 180.0:
        yaw -= 360.0
    return yaw


def shortest_angular_distance_deg(reference_deg: float, target_deg: float) -> float:
    return normalize_yaw_deg(float(target_deg) - float(reference_deg))


def yaw_deg_from_quaternion_xyzw(x: float, y: float, z: float, w: float) -> float:
    norm = math.sqrt((x * x) + (y * y) + (z * z) + (w * w))
    if norm < 1.0e-9:
        raise ValueError("zero-norm quaternion")
    x /= norm
    y /= norm
    z /= norm
    w /= norm
    siny_cosp = 2.0 * ((w * z) + (x * y))
    cosy_cosp = 1.0 - (2.0 * ((y * y) + (z * z)))
    return normalize_yaw_deg(math.degrees(math.atan2(siny_cosp, cosy_cosp)))


def circular_mean_deg(values: list[float]) -> Optional[float]:
    if not values:
        return None
    sum_sin = 0.0
    sum_cos = 0.0
    for value in values:
        radians = math.radians(float(value))
        sum_sin += math.sin(radians)
        sum_cos += math.cos(radians)
    if abs(sum_sin) < 1.0e-9 and abs(sum_cos) < 1.0e-9:
        return None
    return normalize_yaw_deg(math.degrees(math.atan2(sum_sin, sum_cos)))


@dataclass
class AngleSeries:
    values_deg: list[float] = field(default_factory=list)

    def add(self, value_deg: float) -> None:
        self.values_deg.append(normalize_yaw_deg(value_deg))

    def summary(self) -> dict[str, Any]:
        mean_deg = circular_mean_deg(self.values_deg)
        if mean_deg is None:
            return {"count": len(self.values_deg), "mean_deg": None, "max_abs_error_deg": None}
        max_abs_error_deg = 0.0
        for value in self.values_deg:
            max_abs_error_deg = max(
                max_abs_error_deg,
                abs(shortest_angular_distance_deg(mean_deg, value)),
            )
        return {
            "count": len(self.values_deg),
            "mean_deg": float(mean_deg),
            "max_abs_error_deg": float(max_abs_error_deg),
        }

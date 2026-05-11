from __future__ import annotations

import math


def transform_xy_to_map_frame(
    x: float,
    y: float,
    *,
    source_frame: str,
    map_odom_x: float,
    map_odom_y: float,
    map_odom_yaw_deg: float,
) -> tuple[float, float]:
    source = str(source_frame).strip().lower() or "odom"
    if source == "map":
        return float(x), float(y)

    yaw_rad = math.radians(float(map_odom_yaw_deg))
    cos_yaw = math.cos(yaw_rad)
    sin_yaw = math.sin(yaw_rad)
    map_x = float(map_odom_x) + (cos_yaw * float(x)) - (sin_yaw * float(y))
    map_y = float(map_odom_y) + (sin_yaw * float(x)) + (cos_yaw * float(y))
    return float(map_x), float(map_y)

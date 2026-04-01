from __future__ import annotations

from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.nav_benchmarking import body_relative_offsets_to_north_east
from navegacion_gps.nav_benchmarking import offset_lat_lon


def build_block_loop_body_points(
    *,
    long_edge_m: float,
    short_edge_m: float,
    turn_direction: str,
) -> list[dict[str, float]]:
    long_edge = max(1.0, float(long_edge_m))
    short_edge = max(1.0, float(short_edge_m))
    turn_sign = 1.0 if str(turn_direction).strip().lower() != "right" else -1.0
    return [
        {"forward_m": 0.0, "left_m": 0.0, "yaw_delta_deg": 0.0},
        {"forward_m": long_edge, "left_m": 0.0, "yaw_delta_deg": 90.0 * turn_sign},
        {
            "forward_m": long_edge,
            "left_m": short_edge * turn_sign,
            "yaw_delta_deg": 180.0,
        },
        {
            "forward_m": 0.0,
            "left_m": short_edge * turn_sign,
            "yaw_delta_deg": -90.0 * turn_sign,
        },
    ]


def build_block_loop_waypoints(
    *,
    start_lat: float,
    start_lon: float,
    start_yaw_deg: float,
    long_edge_m: float,
    short_edge_m: float,
    turn_direction: str,
) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    for point in build_block_loop_body_points(
        long_edge_m=long_edge_m,
        short_edge_m=short_edge_m,
        turn_direction=turn_direction,
    ):
        north_m, east_m = body_relative_offsets_to_north_east(
            start_yaw_deg=float(start_yaw_deg),
            forward_m=float(point["forward_m"]),
            left_m=float(point["left_m"]),
        )
        lat, lon = offset_lat_lon(
            lat_deg=float(start_lat),
            lon_deg=float(start_lon),
            north_m=float(north_m),
            east_m=float(east_m),
        )
        out.append(
            {
                "lat": float(lat),
                "lon": float(lon),
                "yaw_deg": float(
                    normalize_yaw_deg(float(start_yaw_deg) + float(point["yaw_delta_deg"]))
                ),
            }
        )
    return out


def build_waypoints_yaml_document(waypoints: list[dict[str, float]]) -> dict[str, object]:
    return {
        "waypoints": [
            {
                "latitude": float(item["lat"]),
                "longitude": float(item["lon"]),
                "yaw": float(item["yaw_deg"]),
            }
            for item in waypoints
        ]
    }

import pytest

from navegacion_gps.loop_waypoint_benchmark_core import build_block_loop_body_points
from navegacion_gps.loop_waypoint_benchmark_core import build_block_loop_waypoints
from navegacion_gps.loop_waypoint_benchmark_core import build_waypoints_yaml_document


def test_build_block_loop_body_points_for_left_turn_loop() -> None:
    points = build_block_loop_body_points(
        long_edge_m=20.0,
        short_edge_m=8.0,
        turn_direction="left",
    )

    assert points == [
        {"forward_m": 0.0, "left_m": 0.0, "yaw_delta_deg": 0.0},
        {"forward_m": 20.0, "left_m": 0.0, "yaw_delta_deg": 90.0},
        {"forward_m": 20.0, "left_m": 8.0, "yaw_delta_deg": 180.0},
        {"forward_m": 0.0, "left_m": 8.0, "yaw_delta_deg": -90.0},
    ]


def test_build_block_loop_body_points_for_right_turn_loop() -> None:
    points = build_block_loop_body_points(
        long_edge_m=20.0,
        short_edge_m=8.0,
        turn_direction="right",
    )

    assert points == [
        {"forward_m": 0.0, "left_m": 0.0, "yaw_delta_deg": 0.0},
        {"forward_m": 20.0, "left_m": 0.0, "yaw_delta_deg": -90.0},
        {"forward_m": 20.0, "left_m": -8.0, "yaw_delta_deg": 180.0},
        {"forward_m": 0.0, "left_m": -8.0, "yaw_delta_deg": 90.0},
    ]


def test_build_block_loop_waypoints_wraps_headings_for_left_turn() -> None:
    waypoints = build_block_loop_waypoints(
        start_lat=-34.0,
        start_lon=-58.0,
        start_yaw_deg=0.0,
        long_edge_m=20.0,
        short_edge_m=8.0,
        turn_direction="left",
    )

    assert len(waypoints) == 4
    assert waypoints[0]["yaw_deg"] == pytest.approx(0.0)
    assert waypoints[1]["yaw_deg"] == pytest.approx(90.0)
    assert abs(waypoints[2]["yaw_deg"]) == pytest.approx(180.0)
    assert waypoints[3]["yaw_deg"] == pytest.approx(-90.0)
    assert waypoints[1]["lon"] > waypoints[0]["lon"]
    assert waypoints[2]["lat"] > waypoints[1]["lat"]
    assert waypoints[3]["lon"] == pytest.approx(waypoints[0]["lon"], abs=1.0e-6)


def test_build_waypoints_yaml_document_matches_web_waypoints_shape() -> None:
    doc = build_waypoints_yaml_document(
        [
            {"lat": -34.1, "lon": -58.2, "yaw_deg": 12.0},
            {"lat": -34.2, "lon": -58.3, "yaw_deg": 34.0},
        ]
    )

    assert doc == {
        "waypoints": [
            {"latitude": -34.1, "longitude": -58.2, "yaw": 12.0},
            {"latitude": -34.2, "longitude": -58.3, "yaw": 34.0},
        ]
    }

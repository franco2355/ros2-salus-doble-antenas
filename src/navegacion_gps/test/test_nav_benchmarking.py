from pathlib import Path

import pytest
import yaml

from navegacion_gps.nav_benchmarking import BenchmarkScenario
from navegacion_gps.nav_benchmarking import body_relative_offsets_to_north_east
from navegacion_gps.nav_benchmarking import extract_key_metrics
from navegacion_gps.nav_benchmarking import load_benchmark_catalog
from navegacion_gps.nav_benchmarking import resolve_goal_yaw_deg
from navegacion_gps.nav_benchmarking import select_benchmark_scenarios
from navegacion_gps.nav_benchmarking import summarize_angle_jumps


def test_body_relative_offsets_match_ros_heading_convention() -> None:
    north_m, east_m = body_relative_offsets_to_north_east(0.0, forward_m=5.0, left_m=0.0)
    assert north_m == pytest.approx(0.0)
    assert east_m == pytest.approx(5.0)

    north_m, east_m = body_relative_offsets_to_north_east(90.0, forward_m=5.0, left_m=0.0)
    assert north_m == pytest.approx(5.0)
    assert east_m == pytest.approx(0.0, abs=1.0e-6)


def test_resolve_goal_yaw_supports_relative_mode() -> None:
    scenario = BenchmarkScenario.from_mapping(
        "turn_hold",
        {"type": "body_relative_goal", "yaw_mode": "relative", "yaw_delta_deg": 30.0},
    )

    yaw_deg = resolve_goal_yaw_deg(
        scenario,
        start_yaw_deg=170.0,
        north_m=0.0,
        east_m=1.0,
    )

    assert yaw_deg == pytest.approx(-160.0)


def test_summarize_angle_jumps_counts_large_jumps() -> None:
    summary = summarize_angle_jumps([0.0, 1.0, 2.0, 28.0, 29.0], jump_threshold_deg=10.0)

    assert summary["jump_count"] == 1
    assert summary["max"] == pytest.approx(26.0)


def test_catalog_selection_respects_profile_and_max_difficulty(tmp_path: Path) -> None:
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        yaml.safe_dump(
            {
                "default_profile": "quick",
                "profiles": {"quick": {"scenarios": ["a", "b", "c"]}},
                "scenarios": {
                    "a": {"type": "hold", "difficulty": 0},
                    "b": {"type": "body_relative_goal", "difficulty": 1},
                    "c": {"type": "body_relative_goal", "difficulty": 3},
                },
            }
        ),
        encoding="utf-8",
    )

    catalog = load_benchmark_catalog(catalog_path)
    selected = select_benchmark_scenarios(catalog, max_difficulty=1)

    assert [scenario.scenario_id for scenario in selected] == ["a", "b"]


def test_extract_key_metrics_reads_runner_summary_shape() -> None:
    run = {
        "summary": {
            "outcome": {
                "success": True,
                "timeout": False,
                "duration_s": 12.0,
                "final_goal_error_m": 0.4,
                "goal_distance_m": 6.0,
            },
            "path_tracking": {
                "progress": {"ratio": 0.95},
                "map_base_lateral_error_m": {"absolute": {"max": 0.6, "p95": 0.5}},
                "odom_global_lateral_error_m": {"absolute": {"max": 0.8}},
            },
            "heading_stability": {
                "map_odom_yaw": {"jumps": {"jump_count": 2, "max": 14.0}},
                "map_base_yaw": {"jumps": {"jump_count": 1, "max": 11.0}},
                "gps_course_heading": {"valid_ratio": 0.7},
            },
        }
    }

    metrics = extract_key_metrics(run)

    assert metrics["success"] is True
    assert metrics["final_goal_error_m"] == pytest.approx(0.4)
    assert metrics["map_odom_jump_count"] == 2
    assert metrics["gps_heading_valid_ratio"] == pytest.approx(0.7)

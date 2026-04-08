from pathlib import Path

import pytest

from navegacion_gps.replay_localization_compare import build_replay_compare_report
from navegacion_gps.replay_localization_compare import normalize_delta_yaw_deg
from navegacion_gps.replay_localization_compare import summarize_pose_series


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (PACKAGE_ROOT / relative_path).read_text(encoding="utf-8")


def _dataset_with_pose_samples(samples, *, debug_counts=None, heading_samples=None, tf_samples=None):
    return {
        "bag_path": "/tmp/fake",
        "series": {
            "odometry_local": list(samples),
            "odometry_global": list(samples),
            "gps_odometry_map": list(samples),
        },
        "series_yaw_only": {
            "gps_course_heading": list(heading_samples or []),
        },
        "debug_reason_counts": dict(debug_counts or {}),
        "tf_series": {
            "tf_map_odom": list(tf_samples or samples),
            "tf_odom_base_footprint": list(tf_samples or samples),
        },
    }


def test_replay_localization_launch_reuses_global_localization_stack_for_bag_inputs() -> None:
    launch_contents = _read("launch/replay_localization_global_v2.launch.py")

    assert "localization_global_v2.launch.py" in launch_contents
    assert 'DeclareLaunchArgument("use_sim_time", default_value="True")' in launch_contents
    assert 'DeclareLaunchArgument("enable_map_gps_absolute_measurement", default_value="true")' in launch_contents
    assert 'DeclareLaunchArgument("map_gps_absolute_topic", default_value="/gps/odometry_map")' in launch_contents
    assert 'DeclareLaunchArgument("navsat_use_odometry_yaw", default_value="false")' in launch_contents
    assert 'DeclareLaunchArgument("enable_gps_course_heading", default_value="true")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_require_rtk", default_value="false")' in launch_contents
    assert 'executable="gps_course_heading"' in launch_contents
    assert '"gps_topic": "/gps/fix"' in launch_contents
    assert '"gps_topic": "/gps/fix"' in launch_contents
    assert '"gps_course_heading_topic": "/gps/course_heading"' in launch_contents
    assert '"datum_setter": "false"' in launch_contents


def test_normalize_delta_yaw_deg_wraps_large_rotations() -> None:
    assert normalize_delta_yaw_deg(181.0) == -179.0
    assert normalize_delta_yaw_deg(-181.0) == 179.0


def test_summarize_pose_series_reports_pose_and_yaw_delta() -> None:
    samples = [
        {"stamp_s": 1.0, "x_m": 1.0, "y_m": 2.0, "yaw_deg": 179.0},
        {"stamp_s": 3.0, "x_m": 4.0, "y_m": 6.0, "yaw_deg": -179.0},
    ]

    summary = summarize_pose_series(samples)

    assert summary["count"] == 2
    assert summary["duration_s"] == 2.0
    assert summary["delta"]["x_m"] == 3.0
    assert summary["delta"]["y_m"] == 4.0
    assert summary["delta"]["yaw_deg"] == pytest.approx(2.0)


def test_build_replay_compare_report_tracks_pose_yaw_and_debug_counts() -> None:
    recorded_samples = [
        {"stamp_s": 1.0, "x_m": 0.0, "y_m": 0.0, "yaw_deg": 10.0},
        {"stamp_s": 2.0, "x_m": 1.0, "y_m": 0.0, "yaw_deg": 20.0},
    ]
    replayed_samples = [
        {"stamp_s": 1.02, "x_m": 0.1, "y_m": 0.2, "yaw_deg": 12.0},
        {"stamp_s": 2.02, "x_m": 1.1, "y_m": 0.1, "yaw_deg": 18.0},
    ]
    recorded_heading = [
        {"stamp_s": 1.0, "yaw_deg": 11.0},
        {"stamp_s": 2.0, "yaw_deg": 21.0},
    ]
    replayed_heading = [
        {"stamp_s": 1.02, "yaw_deg": 10.0},
        {"stamp_s": 2.02, "yaw_deg": 22.5},
    ]
    recorded = _dataset_with_pose_samples(
        recorded_samples,
        debug_counts={"ok": 2},
        heading_samples=recorded_heading,
    )
    replayed = _dataset_with_pose_samples(
        replayed_samples,
        debug_counts={"ok": 1, "speed_below_threshold": 1},
        heading_samples=replayed_heading,
    )

    report = build_replay_compare_report(recorded, replayed, max_time_delta_s=0.1)

    assert report["debug_reason_counts"]["recorded"]["ok"] == 2
    assert report["debug_reason_counts"]["replayed"]["speed_below_threshold"] == 1
    odom_delta = report["series"]["odometry_global"]["delta"]
    assert odom_delta["matched_count"] == 2
    assert odom_delta["pos_delta_m"]["max_abs"] > 0.0
    assert odom_delta["yaw_delta_deg"]["max_abs"] == 2.0
    heading_delta = report["series"]["gps_course_heading"]["delta"]
    assert heading_delta["matched_count"] == 2
    assert heading_delta["yaw_delta_deg"]["max_abs"] == pytest.approx(1.5)

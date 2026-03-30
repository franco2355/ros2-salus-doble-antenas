import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from navegacion_gps.gps_course_heading_core import GpsCourseHeadingEstimator  # noqa: E402
from navegacion_gps.gps_course_heading_core import ros_yaw_deg_from_north_east  # noqa: E402


def test_ros_yaw_deg_from_north_east_cardinal_axes() -> None:
    assert ros_yaw_deg_from_north_east(0.0, 1.0) == 0.0
    assert ros_yaw_deg_from_north_east(1.0, 0.0) == 90.0
    assert ros_yaw_deg_from_north_east(0.0, -1.0) == 180.0
    assert ros_yaw_deg_from_north_east(-1.0, 0.0) == -90.0


def test_ros_yaw_deg_from_north_east_handles_wraparound() -> None:
    yaw = ros_yaw_deg_from_north_east(-1.0, -1.0)
    assert -180.0 <= yaw <= 180.0
    assert abs(yaw + 135.0) < 1.0e-6


def test_estimator_rejects_when_distance_is_too_small() -> None:
    estimator = GpsCourseHeadingEstimator(min_distance_m=2.5)
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.000005, -64.0, 0.5)

    estimate = estimator.estimate(
        now_s=0.5,
        speed_mps=1.0,
        steer_deg=0.0,
        steer_valid=True,
        yaw_rate_rps=0.0,
    )

    assert estimate.valid is False
    assert estimate.reason == "distance_below_threshold"


def test_estimator_rejects_when_speed_is_too_low() -> None:
    estimator = GpsCourseHeadingEstimator(min_distance_m=1.0, min_speed_mps=0.8)
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-30.99997, -64.0, 2.0)

    estimate = estimator.estimate(
        now_s=2.0,
        speed_mps=0.2,
        steer_deg=0.0,
        steer_valid=True,
        yaw_rate_rps=0.0,
    )

    assert estimate.valid is False
    assert estimate.reason == "speed_below_threshold"


def test_estimator_rejects_when_steer_is_too_high() -> None:
    estimator = GpsCourseHeadingEstimator(max_abs_steer_deg=6.0)
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-30.99997, -64.0, 2.0)

    estimate = estimator.estimate(
        now_s=2.0,
        speed_mps=1.0,
        steer_deg=12.0,
        steer_valid=True,
        yaw_rate_rps=0.0,
    )

    assert estimate.valid is False
    assert estimate.reason == "steer_too_high"


def test_estimator_rejects_when_yaw_rate_is_too_high() -> None:
    estimator = GpsCourseHeadingEstimator(max_abs_yaw_rate_rps=0.12)
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-30.99997, -64.0, 2.0)

    estimate = estimator.estimate(
        now_s=2.0,
        speed_mps=1.0,
        steer_deg=0.0,
        steer_valid=True,
        yaw_rate_rps=0.3,
    )

    assert estimate.valid is False
    assert estimate.reason == "yaw_rate_too_high"


def test_estimator_accepts_stable_straight_motion() -> None:
    estimator = GpsCourseHeadingEstimator(
        min_distance_m=2.0,
        min_speed_mps=0.8,
        max_abs_steer_deg=6.0,
        max_abs_yaw_rate_rps=0.12,
    )
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.0, -63.99997, 3.0)

    estimate = estimator.estimate(
        now_s=3.0,
        speed_mps=1.2,
        steer_deg=0.5,
        steer_valid=True,
        yaw_rate_rps=0.01,
    )

    assert estimate.valid is True
    assert estimate.reason == "ok"
    assert estimate.yaw_deg is not None
    assert abs(estimate.yaw_deg) < 5.0


def test_estimator_holds_last_valid_heading_during_short_steer_excursion() -> None:
    estimator = GpsCourseHeadingEstimator(
        min_distance_m=2.0,
        min_speed_mps=0.8,
        max_abs_steer_deg=3.0,
        max_abs_yaw_rate_rps=0.06,
        invalid_hold_s=0.8,
    )
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.0, -63.99997, 3.0)

    baseline = estimator.estimate(
        now_s=3.0,
        speed_mps=1.2,
        steer_deg=0.5,
        steer_valid=True,
        yaw_rate_rps=0.01,
    )
    held = estimator.estimate(
        now_s=3.4,
        speed_mps=1.2,
        steer_deg=4.5,
        steer_valid=True,
        yaw_rate_rps=0.05,
    )

    assert baseline.valid is True
    assert baseline.reason == "ok"
    assert held.valid is True
    assert held.reason == "hold_steer_too_high"
    assert held.yaw_deg == baseline.yaw_deg


def test_estimator_prefers_most_recent_segment_over_long_chord() -> None:
    estimator = GpsCourseHeadingEstimator(min_distance_m=2.0)
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.0, -63.99997, 3.0)
    estimator.add_fix(-30.99997, -63.99997, 4.0)

    estimate = estimator.estimate(
        now_s=4.0,
        speed_mps=1.2,
        steer_deg=0.5,
        steer_valid=True,
        yaw_rate_rps=0.01,
    )

    assert estimate.valid is True
    assert estimate.reason == "ok"
    assert estimate.yaw_deg is not None
    assert abs(float(estimate.yaw_deg) - 90.0) < 5.0
    assert estimate.sample_dt_s is not None
    assert abs(float(estimate.sample_dt_s) - 1.0) < 1.0e-6


def test_estimator_rejects_when_recent_segment_is_too_old() -> None:
    estimator = GpsCourseHeadingEstimator(
        min_distance_m=2.0,
        max_sample_dt_s=1.5,
    )
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.0, -63.99997, 2.5)

    estimate = estimator.estimate(
        now_s=2.5,
        speed_mps=1.2,
        steer_deg=0.5,
        steer_valid=True,
        yaw_rate_rps=0.01,
    )

    assert estimate.valid is False
    assert estimate.reason == "distance_below_threshold"


def test_estimator_hold_expires_after_grace_window() -> None:
    estimator = GpsCourseHeadingEstimator(
        min_distance_m=2.0,
        min_speed_mps=0.8,
        max_abs_steer_deg=3.0,
        max_abs_yaw_rate_rps=0.06,
        max_fix_age_s=1.0,
        invalid_hold_s=0.5,
    )
    estimator.add_fix(-31.0, -64.0, 0.0)
    estimator.add_fix(-31.0, -63.99997, 3.0)

    valid = estimator.estimate(
        now_s=3.0,
        speed_mps=1.2,
        steer_deg=0.5,
        steer_valid=True,
        yaw_rate_rps=0.01,
    )
    expired = estimator.estimate(
        now_s=3.7,
        speed_mps=1.2,
        steer_deg=4.5,
        steer_valid=True,
        yaw_rate_rps=0.05,
    )

    assert valid.valid is True
    assert expired.valid is False
    assert expired.reason == "steer_too_high"

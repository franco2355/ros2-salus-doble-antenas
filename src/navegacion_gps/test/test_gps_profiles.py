import pytest
from sensor_msgs.msg import NavSatFix, NavSatStatus

from navegacion_gps.gps_profiles import (
    SimGpsFixProcessor,
    build_custom_gps_profile,
    resolve_gps_profile,
    resolve_gps_profile_from_legacy,
    supported_gps_profiles,
)


def _make_fix(sec: int = 10, nanosec: int = 0) -> NavSatFix:
    msg = NavSatFix()
    msg.header.stamp.sec = sec
    msg.header.stamp.nanosec = nanosec
    msg.latitude = -31.4858037
    msg.longitude = -64.2410570
    msg.altitude = 0.0
    return msg


def test_supported_gps_profiles_are_explicit_and_stable() -> None:
    assert supported_gps_profiles() == ("f9p_rtk", "ideal", "m8n")


@pytest.mark.parametrize(
    ("profile_name", "rtk_status", "navsat_status"),
    [
        ("ideal", "SIM_IDEAL", NavSatStatus.STATUS_FIX),
        ("f9p_rtk", "RTK_FIXED", NavSatStatus.STATUS_GBAS_FIX),
        ("m8n", "3D_FIX", NavSatStatus.STATUS_FIX),
    ],
)
def test_resolve_gps_profile_returns_expected_metadata(
    profile_name: str,
    rtk_status: str,
    navsat_status: int,
) -> None:
    profile = resolve_gps_profile(profile_name)

    assert profile.name == profile_name
    assert profile.rtk_status_text == rtk_status
    assert profile.navsat_status == navsat_status


def test_resolve_gps_profile_rejects_invalid_value() -> None:
    with pytest.raises(ValueError, match="Unsupported gps_profile"):
        resolve_gps_profile("bad_profile")


def test_legacy_resolution_prefers_explicit_profile() -> None:
    profile = resolve_gps_profile_from_legacy("f9p_rtk", realism_mode_enabled=False)

    assert profile.name == "f9p_rtk"


@pytest.mark.parametrize(
    ("realism_mode_enabled", "expected_profile"),
    [(False, "ideal"), (True, "m8n")],
)
def test_legacy_resolution_maps_realism_mode(
    realism_mode_enabled: bool,
    expected_profile: str,
) -> None:
    profile = resolve_gps_profile_from_legacy("", realism_mode_enabled)

    assert profile.name == expected_profile


def test_ideal_profile_is_true_passthrough_with_tiny_covariance() -> None:
    processor = SimGpsFixProcessor(resolve_gps_profile("ideal"), random_seed=123)
    msg = _make_fix()

    out = processor.process_fix(msg, reference_time_ns=10_000_000_000)

    assert out is not None
    assert out.latitude == msg.latitude
    assert out.longitude == msg.longitude
    assert out.altitude == msg.altitude
    assert out.position_covariance[0] == pytest.approx(0.01**2)
    assert out.position_covariance[8] == pytest.approx(0.02**2)
    assert processor.rtk_status_text() == "SIM_IDEAL"


def test_f9p_rtk_profile_adds_small_noise_and_sets_rtk_status() -> None:
    processor = SimGpsFixProcessor(resolve_gps_profile("f9p_rtk"), random_seed=123)
    msg = _make_fix()

    out = processor.process_fix(msg, reference_time_ns=10_000_000_000)

    assert out is not None
    assert out.position_covariance[0] == pytest.approx(0.02**2)
    assert out.position_covariance[8] == pytest.approx(0.04**2)
    assert out.status.status == NavSatStatus.STATUS_GBAS_FIX
    assert processor.rtk_status_text() == "RTK_FIXED"


def test_m8n_profile_throttles_publish_rate() -> None:
    processor = SimGpsFixProcessor(resolve_gps_profile("m8n"), random_seed=123)
    msg1 = _make_fix(sec=10, nanosec=0)
    msg2 = _make_fix(sec=10, nanosec=50_000_000)
    msg3 = _make_fix(sec=10, nanosec=250_000_000)

    out1 = processor.process_fix(msg1, reference_time_ns=10_000_000_000)
    out2 = processor.process_fix(msg2, reference_time_ns=10_050_000_000)
    out3 = processor.process_fix(msg3, reference_time_ns=10_250_000_000)

    assert out1 is not None
    assert out2 is None
    assert out3 is not None
    assert out3.status.status == NavSatStatus.STATUS_FIX
    assert processor.rtk_status_text() == "3D_FIX"


def test_custom_legacy_profile_preserves_explicit_noise_values() -> None:
    profile = build_custom_gps_profile(
        name="legacy_realistic",
        publish_rate_hz=7.5,
        publish_jitter_stddev_s=0.05,
        horizontal_noise_stddev_m=0.4,
        vertical_noise_stddev_m=0.8,
        bias_walk_stddev_m_per_sqrt_s=0.03,
        navsat_status=NavSatStatus.STATUS_FIX,
        rtk_status_text="3D_FIX",
        description="legacy",
    )

    assert profile.publish_rate_hz == pytest.approx(7.5)
    assert profile.horizontal_covariance_m2 == pytest.approx(0.4**2)
    assert profile.vertical_covariance_m2 == pytest.approx(0.8**2)

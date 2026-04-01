import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from sensores.rtk_bridge_core import GPS_FIX_TYPE_3D_FIX  # noqa: E402
from sensores.rtk_bridge_core import GPS_FIX_TYPE_RTK_FIXED  # noqa: E402
from sensores.rtk_bridge_core import GPS_FIX_TYPE_RTK_FLOAT  # noqa: E402
from sensores.rtk_bridge_core import NAVSAT_STATUS_FIX  # noqa: E402
from sensores.rtk_bridge_core import NAVSAT_STATUS_GBAS_FIX  # noqa: E402
from sensores.rtk_bridge_core import RtkStatusInputs  # noqa: E402
from sensores.rtk_bridge_core import resolve_rtk_status  # noqa: E402


def _inputs(**overrides) -> RtkStatusInputs:
    baseline = dict(
        mavros_rtk_consumer_present=True,
        navsat_status=NAVSAT_STATUS_FIX,
        gpsraw_fix_type=None,
        gpsraw_fresh=False,
        gpsrtk_fresh=False,
        baseline_fresh=False,
        rtcm_received_count=0,
        rtcm_age_s=999.0,
        rtcm_stale_timeout_s=5.0,
    )
    baseline.update(overrides)
    return RtkStatusInputs(**baseline)


def test_resolve_rtk_status_waits_for_mavros_consumer() -> None:
    status = resolve_rtk_status(_inputs(mavros_rtk_consumer_present=False))

    assert status == "waiting_for_mavros_gps_rtk"


def test_resolve_rtk_status_prefers_gpsraw_rtk_float() -> None:
    status = resolve_rtk_status(
        _inputs(
            gpsraw_fix_type=GPS_FIX_TYPE_RTK_FLOAT,
            gpsraw_fresh=True,
            rtcm_received_count=10,
            rtcm_age_s=0.2,
        )
    )

    assert status == "rtk_float"


def test_resolve_rtk_status_prefers_gpsraw_rtk_fixed() -> None:
    status = resolve_rtk_status(
        _inputs(
            gpsraw_fix_type=GPS_FIX_TYPE_RTK_FIXED,
            gpsraw_fresh=True,
            rtcm_received_count=10,
            rtcm_age_s=0.2,
        )
    )

    assert status == "rtk_fixed"


def test_resolve_rtk_status_reports_gps_only_without_rtcm() -> None:
    status = resolve_rtk_status(
        _inputs(
            gpsraw_fix_type=GPS_FIX_TYPE_3D_FIX,
            gpsraw_fresh=True,
            rtcm_received_count=0,
        )
    )

    assert status == "gps_only"


def test_resolve_rtk_status_reports_rtcm_ok_before_rtk_solution() -> None:
    status = resolve_rtk_status(
        _inputs(
            gpsraw_fix_type=GPS_FIX_TYPE_3D_FIX,
            gpsraw_fresh=True,
            rtcm_received_count=25,
            rtcm_age_s=0.3,
        )
    )

    assert status == "rtcm_ok"


def test_resolve_rtk_status_reports_rtcm_stale_before_rtk_solution() -> None:
    status = resolve_rtk_status(
        _inputs(
            gpsraw_fix_type=GPS_FIX_TYPE_3D_FIX,
            gpsraw_fresh=True,
            rtcm_received_count=25,
            rtcm_age_s=8.0,
        )
    )

    assert status == "rtcm_stale"


def test_resolve_rtk_status_falls_back_to_navsat_and_rtk_topics() -> None:
    status = resolve_rtk_status(
        _inputs(
            navsat_status=NAVSAT_STATUS_GBAS_FIX,
            gpsrtk_fresh=True,
            rtcm_received_count=25,
            rtcm_age_s=0.3,
        )
    )

    assert status == "rtk_fix"

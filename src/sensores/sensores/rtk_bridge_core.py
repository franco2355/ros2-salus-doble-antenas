from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


GPS_FIX_TYPE_NO_GPS = 0
GPS_FIX_TYPE_NO_FIX = 1
GPS_FIX_TYPE_2D_FIX = 2
GPS_FIX_TYPE_3D_FIX = 3
GPS_FIX_TYPE_DGPS = 4
GPS_FIX_TYPE_RTK_FLOAT = 5
GPS_FIX_TYPE_RTK_FIXED = 6
GPS_FIX_TYPE_STATIC = 7
GPS_FIX_TYPE_PPP = 8

NAVSAT_STATUS_NO_FIX = -1
NAVSAT_STATUS_FIX = 0
NAVSAT_STATUS_SBAS_FIX = 1
NAVSAT_STATUS_GBAS_FIX = 2


@dataclass(frozen=True)
class RtkStatusInputs:
    mavros_rtk_consumer_present: bool
    navsat_status: Optional[int]
    gpsraw_fix_type: Optional[int]
    gpsraw_fresh: bool
    gpsrtk_fresh: bool
    baseline_fresh: bool
    rtcm_received_count: int
    rtcm_age_s: float
    rtcm_stale_timeout_s: float


def resolve_rtk_status(inputs: RtkStatusInputs) -> str:
    if not inputs.mavros_rtk_consumer_present:
        return "waiting_for_mavros_gps_rtk"

    if inputs.gpsraw_fresh and inputs.gpsraw_fix_type is not None:
        return _status_from_gpsraw_fix_type(
            fix_type=int(inputs.gpsraw_fix_type),
            rtcm_received_count=int(inputs.rtcm_received_count),
            rtcm_age_s=float(inputs.rtcm_age_s),
            rtcm_stale_timeout_s=float(inputs.rtcm_stale_timeout_s),
        )

    if inputs.navsat_status is None:
        return "waiting_for_gps"

    if int(inputs.navsat_status) <= NAVSAT_STATUS_NO_FIX:
        return "gps_no_fix"

    if inputs.gpsrtk_fresh or inputs.baseline_fresh:
        if int(inputs.navsat_status) >= NAVSAT_STATUS_GBAS_FIX:
            return "rtk_fix"
        if int(inputs.rtcm_received_count) > 0:
            if float(inputs.rtcm_age_s) > float(inputs.rtcm_stale_timeout_s):
                return "rtcm_stale"
            return "rtcm_ok"

    if int(inputs.rtcm_received_count) == 0:
        return "gps_only"
    if float(inputs.rtcm_age_s) > float(inputs.rtcm_stale_timeout_s):
        return "rtcm_stale"
    return "rtcm_ok"


def _status_from_gpsraw_fix_type(
    *,
    fix_type: int,
    rtcm_received_count: int,
    rtcm_age_s: float,
    rtcm_stale_timeout_s: float,
) -> str:
    if fix_type <= GPS_FIX_TYPE_NO_FIX:
        return "gps_no_fix"
    if fix_type == GPS_FIX_TYPE_RTK_FLOAT:
        return "rtk_float"
    if fix_type == GPS_FIX_TYPE_RTK_FIXED:
        return "rtk_fixed"
    if fix_type == GPS_FIX_TYPE_STATIC:
        return "gps_static"
    if fix_type == GPS_FIX_TYPE_PPP:
        return "ppp"
    if rtcm_received_count == 0:
        return "gps_only"
    if rtcm_age_s > rtcm_stale_timeout_s:
        return "rtcm_stale"
    return "rtcm_ok"

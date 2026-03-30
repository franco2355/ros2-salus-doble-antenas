from navegacion_gps.gps_course_heading import is_rtk_status_allowed
from navegacion_gps.gps_course_heading import normalize_rtk_status_label
from navegacion_gps.gps_course_heading import parse_allowed_rtk_statuses


def test_normalize_rtk_status_label_accepts_bridge_and_pixhawk_variants() -> None:
    assert normalize_rtk_status_label("RTK_FIXED") == "rtk_fixed"
    assert normalize_rtk_status_label("rtk_fix") == "rtk_fix"
    assert normalize_rtk_status_label(" RTK-FLOAT ") == "rtk_float"


def test_parse_allowed_rtk_statuses_deduplicates_and_normalizes() -> None:
    allowed = parse_allowed_rtk_statuses("RTK_FIXED, rtk_fix, RTK-FIXED")

    assert allowed == ("rtk_fixed", "rtk_fix")


def test_is_rtk_status_allowed_matches_normalized_statuses() -> None:
    allowed = parse_allowed_rtk_statuses("RTK_FIXED,RTK_FIX")

    assert is_rtk_status_allowed("RTK_FIXED", allowed) is True
    assert is_rtk_status_allowed("rtk_fix", allowed) is True
    assert is_rtk_status_allowed("RTK_FLOAT", allowed) is False

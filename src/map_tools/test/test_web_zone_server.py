from diagnostic_msgs.msg import DiagnosticStatus

from map_tools.web_zone_server import COCKPIT_NAV2_UI_CONFIG_DEFAULTS
from map_tools.web_zone_server import ROSBAG_TOPIC_PROFILES, WebZoneServerNode


def _diag_level(value) -> int:
    if isinstance(value, (bytes, bytearray)):
        return int.from_bytes(value, byteorder="little", signed=False)
    return int(value)


class _FakeNode:
    _diag_level_value = staticmethod(WebZoneServerNode._diag_level_value)
    _should_surface_diagnostic = WebZoneServerNode._should_surface_diagnostic
    _rosbag_topics_for_profile = staticmethod(WebZoneServerNode._rosbag_topics_for_profile)
    _normalize_gps_status_text = staticmethod(WebZoneServerNode._normalize_gps_status_text)
    _normalize_camera_frame_encoding = staticmethod(
        WebZoneServerNode._normalize_camera_frame_encoding
    )
    _build_gps_status_payload = staticmethod(WebZoneServerNode._build_gps_status_payload)
    _build_gps_status_payload_from_navsat = staticmethod(
        WebZoneServerNode._build_gps_status_payload_from_navsat
    )
    _normalize_cockpit_nav2_ui_config = staticmethod(
        WebZoneServerNode._normalize_cockpit_nav2_ui_config
    )


class _FakeStatus:
    def __init__(self, name: str, level, message: str) -> None:
        self.name = name
        self.level = level
        self.message = message


def test_should_surface_diagnostic_accepts_navigation_errors():
    node = _FakeNode()
    status = _FakeStatus(
        "navigation/nav_command_server",
        DiagnosticStatus.ERROR,
        "failure=GOAL_RESULT_ABORTED",
    )

    assert node._should_surface_diagnostic(status) is True


def test_should_surface_diagnostic_filters_non_navigation_status():
    node = _FakeNode()
    status = _FakeStatus("ekf_filter_node_map", DiagnosticStatus.ERROR, "stale")

    assert node._should_surface_diagnostic(status) is False


def test_should_surface_diagnostic_filters_idle_collision_monitor_warning():
    node = _FakeNode()
    status = _FakeStatus(
        "navigation/collision_monitor",
        DiagnosticStatus.WARN,
        "no collision monitor state yet",
    )

    assert node._should_surface_diagnostic(status) is False


def test_rosbag_topics_for_profile_matches_declared_profiles():
    topics = _FakeNode._rosbag_topics_for_profile("core")

    assert topics == ROSBAG_TOPIC_PROFILES["core"]
    assert "/global_position/raw/fix" in topics
    assert "/gps/rtk_status_mavros" in topics
    assert "/gps/odometry_map" in topics
    assert "/gps/course_heading" in topics
    assert "/gps/course_heading/debug" in topics
    assert "/odometry/global" in topics
    assert "/controller/drive_telemetry" in topics
    assert "/diagnostics" in topics
    assert "/nav_command_server/events" in topics
    assert _FakeNode._rosbag_topics_for_profile("missing") is None


def test_normalize_gps_status_text_handles_common_variants():
    assert _FakeNode._normalize_gps_status_text("RTK_FIXED") == "rtk_fixed"
    assert _FakeNode._normalize_gps_status_text("3D-FIX") == "3d_fix"
    assert _FakeNode._normalize_gps_status_text(" waiting for gps ") == "waiting_for_gps"


def test_build_gps_status_payload_maps_quality_to_label_and_level():
    payload = _FakeNode._build_gps_status_payload(
        raw="RTK_FLOAT",
        source="rtk_status",
        available=True,
    )

    assert payload["label"] == "RTK FLOAT"
    assert payload["level"] == "warn"
    assert payload["normalized"] == "rtk_float"
    assert payload["source"] == "rtk_status"


def test_build_gps_status_payload_from_navsat_falls_back_to_3d_fix():
    payload = _FakeNode._build_gps_status_payload_from_navsat(0)

    assert payload["label"] == "3D FIX"
    assert payload["level"] == "warn"
    assert payload["source"] == "gps_fix"


def test_normalize_camera_frame_encoding_defaults_to_jpeg():
    assert _FakeNode._normalize_camera_frame_encoding("png") == "png"
    assert _FakeNode._normalize_camera_frame_encoding("jpg") == "jpeg"
    assert _FakeNode._normalize_camera_frame_encoding("unexpected") == "jpeg"


def test_normalize_cockpit_nav2_ui_config_uses_defaults_for_invalid_payload():
    payload = _FakeNode._normalize_cockpit_nav2_ui_config(None)

    assert payload == COCKPIT_NAV2_UI_CONFIG_DEFAULTS


def test_normalize_cockpit_nav2_ui_config_clamps_and_validates_ranges():
    payload = _FakeNode._normalize_cockpit_nav2_ui_config(
        {
            "ws_real_host": " salus ",
            "ws_real_port": 99999,
            "ws_sim_host": "",
            "ws_sim_port": -10,
            "camera_probe_timeout_ms": 200,
            "camera_load_timeout_ms": 50,
            "map_default_center_lat": -31.5,
            "map_default_center_lon": -64.2,
            "map_default_zoom": 99,
            "manual_linear_speed_min": 2.0,
            "manual_linear_speed_max": 1.0,
            "manual_linear_speed_default": 9.0,
            "manual_angular_speed_min": 0.8,
            "manual_angular_speed_max": 0.2,
            "manual_angular_speed_default": 5.0,
            "manual_loop_interval_ms": 5,
        }
    )

    assert payload["ws_real_host"] == "salus"
    assert payload["ws_real_port"] == 65535
    assert payload["ws_sim_host"] == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["ws_sim_host"]
    assert payload["ws_sim_port"] == 1
    assert payload["camera_probe_timeout_ms"] == 500
    assert payload["camera_load_timeout_ms"] == 1000
    assert payload["map_default_center_lat"] == -31.5
    assert payload["map_default_center_lon"] == -64.2
    assert payload["map_default_zoom"] == 22
    assert payload["manual_linear_speed_min"] == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_linear_speed_min"]
    assert payload["manual_linear_speed_max"] == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_linear_speed_max"]
    assert (
        payload["manual_linear_speed_default"]
        == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_linear_speed_max"]
    )
    assert payload["manual_angular_speed_min"] == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_angular_speed_min"]
    assert payload["manual_angular_speed_max"] == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_angular_speed_max"]
    assert (
        payload["manual_angular_speed_default"]
        == COCKPIT_NAV2_UI_CONFIG_DEFAULTS["manual_angular_speed_max"]
    )
    assert payload["manual_loop_interval_ms"] == 20

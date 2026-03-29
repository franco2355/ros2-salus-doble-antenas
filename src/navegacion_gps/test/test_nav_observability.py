import math
from types import SimpleNamespace

from diagnostic_msgs.msg import DiagnosticStatus

from navegacion_gps.nav_observability import (
    DIAG_ERROR,
    DIAG_WARN,
    NavObservabilityNode,
    classify_age,
    parse_json_string_payload,
)


def _diag_level(value) -> int:
    if isinstance(value, (bytes, bytearray)):
        return int.from_bytes(value, byteorder="little", signed=False)
    return int(value)


def test_parse_json_string_payload_accepts_dict_only():
    assert parse_json_string_payload('{"ok": true, "value": 1}') == {"ok": True, "value": 1}
    assert parse_json_string_payload('["not", "a", "dict"]') is None
    assert parse_json_string_payload("not json") is None


def test_classify_age_returns_error_for_missing_or_non_finite_age():
    assert classify_age(None, 1.0, 2.0) == _diag_level(DiagnosticStatus.ERROR)
    assert classify_age(math.nan, 1.0, 2.0) == _diag_level(DiagnosticStatus.ERROR)


def test_classify_age_respects_warn_and_error_thresholds():
    assert classify_age(0.5, 1.0, 2.0) == _diag_level(DiagnosticStatus.OK)
    assert classify_age(1.5, 1.0, 2.0) == _diag_level(DiagnosticStatus.WARN)
    assert classify_age(2.5, 1.0, 2.0) == _diag_level(DiagnosticStatus.ERROR)


class _FakeObservabilityNode:
    _kv = staticmethod(NavObservabilityNode._kv)
    _make_status = NavObservabilityNode._make_status
    _build_controller_server_status = NavObservabilityNode._build_controller_server_status
    _build_nav_command_server_status = NavObservabilityNode._build_nav_command_server_status
    _build_collision_monitor_status = NavObservabilityNode._build_collision_monitor_status

    def __init__(self) -> None:
        self.use_sim_time = False
        self.controller_stale_warn_s = 1.0
        self.controller_stale_error_s = 3.0
        self.nav_telemetry_stale_warn_s = 1.0
        self.nav_telemetry_stale_error_s = 3.0
        self.cmd_stale_warn_s = 1.0
        self.cmd_stale_error_s = 3.0
        self._ages = {}
        self._last_nav_telemetry = None
        self._last_nav_event = None
        self._last_controller_status = None
        self._last_controller_telemetry = None
        self._last_collision_stop_active = False

    def _age(self, key):
        return self._ages.get(key)


def test_build_controller_server_status_reports_estop_and_source_from_json():
    node = _FakeObservabilityNode()
    node._ages["controller_status"] = 0.2
    node._ages["controller_telemetry"] = 0.1
    node._last_controller_telemetry = {
        "telemetry": {
            "control_source": "nav",
            "estop_active": True,
            "failsafe_active": False,
        }
    }

    status = node._build_controller_server_status()

    assert _diag_level(status.level) == DIAG_ERROR
    assert status.name == "navigation/controller_server"
    assert status.message == "controller estop/failsafe active"
    values = {item.key: item.value for item in status.values}
    assert values["controller_source"] == "nav"
    assert values["estop_active"] == "True"
    assert values["failsafe_active"] == "False"


def test_build_nav_command_server_status_includes_failure_and_last_event():
    node = _FakeObservabilityNode()
    node._ages["nav_telemetry"] = 0.1
    node._last_nav_telemetry = SimpleNamespace(
        auto_mode="point_to_point",
        goal_active=True,
        failure_code="GOAL_RESULT_ABORTED",
        failure_component="nav2",
        nav_result_status=6,
    )
    node._last_nav_event = SimpleNamespace(code="GOAL_RESULT_ABORTED")

    status = node._build_nav_command_server_status()

    assert _diag_level(status.level) == DIAG_ERROR
    assert status.name == "navigation/nav_command_server"
    assert status.message == "failure=GOAL_RESULT_ABORTED"
    values = {item.key: item.value for item in status.values}
    assert values["auto_mode"] == "point_to_point"
    assert values["goal_active"] == "True"
    assert values["failure_code"] == "GOAL_RESULT_ABORTED"
    assert values["failure_component"] == "nav2"
    assert values["last_event_code"] == "GOAL_RESULT_ABORTED"


def test_build_collision_monitor_status_is_warn_until_first_state_when_idle():
    node = _FakeObservabilityNode()
    node._last_nav_telemetry = SimpleNamespace(goal_active=False)

    status = node._build_collision_monitor_status()

    assert _diag_level(status.level) == DIAG_WARN
    assert status.message == "no collision monitor state yet"


def test_build_collision_monitor_status_is_error_without_state_during_active_goal():
    node = _FakeObservabilityNode()
    node._last_nav_telemetry = SimpleNamespace(goal_active=True)

    status = node._build_collision_monitor_status()

    assert _diag_level(status.level) == DIAG_ERROR
    assert status.message == "goal active but no collision monitor state"

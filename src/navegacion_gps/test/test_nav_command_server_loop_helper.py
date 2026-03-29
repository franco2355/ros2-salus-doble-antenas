import threading
from types import SimpleNamespace

from action_msgs.msg import GoalStatus

from navegacion_gps.nav_command_server import NavCommandServerNode


def test_build_loop_restart_poses_for_many_items():
    poses = [1, 2, 3, 4]
    restarted = NavCommandServerNode._build_loop_restart_poses(poses)
    assert restarted == [2, 3, 4, 1]


def test_build_loop_restart_poses_for_two_items():
    poses = [10, 20]
    restarted = NavCommandServerNode._build_loop_restart_poses(poses)
    assert restarted == [20, 10]


def test_build_loop_restart_poses_for_zero_or_one():
    assert NavCommandServerNode._build_loop_restart_poses([]) == []
    assert NavCommandServerNode._build_loop_restart_poses([7]) == [7]


class _FakeLogger:
    def __init__(self):
        self.info_msgs = []
        self.warn_msgs = []
        self.error_msgs = []

    def info(self, msg: str) -> None:
        self.info_msgs.append(str(msg))

    def warning(self, msg: str) -> None:
        self.warn_msgs.append(str(msg))

    def error(self, msg: str) -> None:
        self.error_msgs.append(str(msg))


class _FakeResultFuture:
    def __init__(self, status: int, missed_waypoints=None):
        if missed_waypoints is None:
            missed_waypoints = []
        self._result = SimpleNamespace(
            status=int(status),
            result=SimpleNamespace(missed_waypoints=list(missed_waypoints)),
        )

    def result(self):
        return self._result


class _FakeLoopNode:
    _diag_level_value = staticmethod(NavCommandServerNode._diag_level_value)

    def __init__(self):
        self._lock = threading.Lock()
        self._current_goal_handle = object()
        self._loop_enabled = True
        self._loop_waypoint_poses = [1, 2]
        self._loop_original_poses = [1, 2, 3]
        self._loop_restart_poses = [2, 3, 1]
        self._manual_enabled = False
        self._is_navigating = True
        self._auto_mode = "loop"
        self._active_action = "navigate_through_poses"
        self._failure_code = ""
        self._failure_component = ""

        self._send_ok = True
        self._send_err = ""
        self.sent_calls = []
        self.telemetry_forced = []
        self.brake_calls = []
        self.events = []
        self.logger = _FakeLogger()

    def _send_nav_goal_for_poses(self, poses, loop_enabled, reason):
        self.sent_calls.append((list(poses), bool(loop_enabled), str(reason)))
        return bool(self._send_ok), str(self._send_err)

    def _publish_telemetry(self, force=False):
        self.telemetry_forced.append(bool(force))

    def _clear_loop_config_locked(self) -> None:
        self._loop_waypoint_poses = []
        self._loop_original_poses = []
        self._loop_restart_poses = []
        self._loop_enabled = False

    def _publish_brake_sequence(self, brake_pct: int) -> None:
        self.brake_calls.append(int(brake_pct))

    def _set_failure_locked(self, code: str = "", component: str = "") -> None:
        self._failure_code = str(code)
        self._failure_component = str(component)

    def _publish_event(self, severity, component, code, message, *, details=None):
        severity_value = self._diag_level_value(severity)
        self.events.append(
            {
                "severity": severity_value,
                "component": str(component),
                "code": str(code),
                "message": str(message),
                "details": dict(details or {}),
            }
        )
        if severity_value >= 2:
            self.logger.error(str(message))
        elif severity_value >= 1:
            self.logger.warning(str(message))
        else:
            self.logger.info(str(message))
        return len(self.events)

    def get_logger(self):
        return self.logger


def test_result_callback_restarts_with_rotated_path_on_each_success():
    node = _FakeLoopNode()

    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_SUCCEEDED),
    )
    assert node.sent_calls[0] == ([2, 3, 1], True, "loop_restart_rotated")
    assert node._is_navigating is True
    assert node._auto_mode == "loop"

    node._current_goal_handle = object()
    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_SUCCEEDED),
    )
    assert node.sent_calls[1] == ([2, 3, 1], True, "loop_restart_rotated")
    assert node._is_navigating is True
    assert node._auto_mode == "loop"


def test_result_callback_stops_loop_when_status_not_succeeded():
    node = _FakeLoopNode()

    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_ABORTED),
    )
    assert node.sent_calls == []
    assert node.brake_calls == [100]
    assert node._is_navigating is False
    assert node._auto_mode == "idle"
    assert node._loop_enabled is False


def test_result_callback_stops_loop_when_restart_send_fails():
    node = _FakeLoopNode()
    node._send_ok = False
    node._send_err = "goal rejected by NavigateThroughPoses"

    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_SUCCEEDED),
    )
    assert len(node.sent_calls) == 1
    assert node._loop_enabled is False
    assert node._loop_original_poses == []
    assert node._loop_restart_poses == []
    assert node.brake_calls == [100]
    assert node._is_navigating is False
    assert node._auto_mode == "idle"
    assert any("Loop restart failed" in msg for msg in node.logger.warn_msgs)


def test_result_callback_point_to_point_stops_on_success():
    node = _FakeLoopNode()
    node._loop_enabled = False
    node._auto_mode = "point_to_point"
    node._loop_original_poses = []
    node._loop_restart_poses = []

    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_SUCCEEDED),
    )
    assert node.sent_calls == []
    assert node.brake_calls == [100]
    assert node._is_navigating is False
    assert node._auto_mode == "idle"


def test_result_callback_point_to_point_manual_mode_does_not_brake():
    node = _FakeLoopNode()
    node._loop_enabled = False
    node._auto_mode = "point_to_point"
    node._manual_enabled = True
    node._loop_original_poses = []
    node._loop_restart_poses = []

    NavCommandServerNode._on_nav_action_result_done(
        node,
        "NavigateThroughPoses",
        _FakeResultFuture(GoalStatus.STATUS_ABORTED),
    )
    assert node.sent_calls == []
    assert node.brake_calls == []
    assert node._is_navigating is False
    assert node._auto_mode == "idle"

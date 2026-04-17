from __future__ import annotations

import threading
import types

import pytest

from navegacion_gps.loop_patrol_runner import _compute_approach_bearing_enu
from navegacion_gps.loop_patrol_runner import LoopPatrolRunnerNode


class _FakeLogger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, message: str) -> None:
        self.warnings.append(message)


class _FakeSetGoalClient:
    def __init__(self) -> None:
        self.requests = []

    def wait_for_service(self, timeout_sec: float = 0.0) -> bool:
        _ = timeout_sec
        return True

    def call_async(self, request):
        self.requests.append(request)

        class _Future:
            def add_done_callback(self, callback) -> None:
                _ = callback

        return _Future()


class _FakeLoopNode:
    def __init__(self, waypoints, current_index: int, prev_wp_index: int) -> None:
        self._lock = threading.Lock()
        self._active = True
        self._waypoints = waypoints
        self._current_index = current_index
        self._prev_wp_index = prev_wp_index
        self._nav_mode = "global"
        self._warned_local_fallback = False
        self._goal_request_pending = False
        self._goal_in_flight = False
        self._next_dispatch_monotonic = 0.0
        self._set_goal_client = _FakeSetGoalClient()
        self._logger = _FakeLogger()
        self.failure_reason = ""
        self._build_goal_request = types.MethodType(
            LoopPatrolRunnerNode._build_goal_request,
            self,
        )

    def get_logger(self) -> _FakeLogger:
        return self._logger

    def _handle_goal_failure(self, reason: str) -> None:
        self.failure_reason = reason

    def _on_set_goal_done(self, future) -> None:
        _ = future


def test_compute_approach_bearing_enu_matches_expected_cardinals() -> None:
    east = _compute_approach_bearing_enu(-31.485, -64.241, -31.485, -64.240)
    north = _compute_approach_bearing_enu(-31.486, -64.241, -31.485, -64.241)
    west = _compute_approach_bearing_enu(-31.485, -64.240, -31.485, -64.241)

    assert east == pytest.approx(0.0, abs=0.5)
    assert north == pytest.approx(90.0, abs=0.5)
    assert west == pytest.approx(180.0, abs=0.5)


def test_compute_approach_bearing_enu_returns_none_for_nearly_identical_points() -> None:
    bearing = _compute_approach_bearing_enu(
        -31.4850000001,
        -64.2410000001,
        -31.4850000001,
        -64.2410000001,
    )

    assert bearing is None


def test_dispatch_current_waypoint_uses_wraparound_approach_bearing_for_return_leg() -> None:
    node = _FakeLoopNode(
        waypoints=[
            {"lat": -31.485, "lon": -64.241, "yaw_deg": 0.0, "label": "wp_0"},
            {"lat": -31.485, "lon": -64.240, "yaw_deg": 0.0, "label": "wp_1"},
        ],
        current_index=0,
        prev_wp_index=-1,
    )

    LoopPatrolRunnerNode._dispatch_current_waypoint(node)

    assert node.failure_reason == ""
    assert len(node._set_goal_client.requests) == 1
    request = node._set_goal_client.requests[0]
    assert request.yaw_deg == pytest.approx(180.0, abs=0.5)
    assert request.yaws_deg == pytest.approx([180.0], abs=0.5)


def test_dispatch_current_waypoint_uses_previous_waypoint_bearing_when_available() -> None:
    node = _FakeLoopNode(
        waypoints=[
            {"lat": -31.485, "lon": -64.241, "yaw_deg": 42.0, "label": "wp_0"},
            {"lat": -31.485, "lon": -64.240, "yaw_deg": 42.0, "label": "wp_1"},
        ],
        current_index=1,
        prev_wp_index=0,
    )

    LoopPatrolRunnerNode._dispatch_current_waypoint(node)

    assert node.failure_reason == ""
    assert len(node._set_goal_client.requests) == 1
    request = node._set_goal_client.requests[0]
    assert request.yaw_deg == pytest.approx(0.0, abs=0.5)
    assert request.yaws_deg == pytest.approx([0.0], abs=0.5)

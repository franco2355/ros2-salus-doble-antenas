"""
Unit tests for VisionBrakeGuardLogic.

No ROS infrastructure needed — the logic class is pure Python.
"""
from __future__ import annotations

import pytest

from navegacion_gps.vision_brake_guard_logic import GuardInput, VisionBrakeGuardLogic


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_logic(**overrides) -> VisionBrakeGuardLogic:
    defaults = dict(
        trigger_labels=['person', 'car'],
        min_score=0.60,
        min_area_norm=0.04,
        required_consecutive_hits=3,
        retrigger_cooldown_s=5.0,
        enabled=True,
        active_only_when_goal_active=True,
        active_in_manual=False,
    )
    defaults.update(overrides)
    return VisionBrakeGuardLogic(**defaults)


def _qualifying_input(**overrides) -> GuardInput:
    defaults = dict(
        fresh=True,
        available=True,
        label='person',
        score=0.80,
        area_norm=0.10,
        goal_active=True,
        manual_enabled=False,
    )
    defaults.update(overrides)
    return GuardInput(**defaults)


def _arm_to_trigger(logic: VisionBrakeGuardLogic, hits: int, now: float = 0.0) -> bool:
    """Feed `hits` qualifying samples. Returns the result of the last update()."""
    result = False
    for i in range(hits):
        result = logic.update(_qualifying_input(), now + i * 0.1)
    return result


# ---------------------------------------------------------------------------
# Global enable / nav-state guards
# ---------------------------------------------------------------------------

def test_disabled_never_triggers() -> None:
    logic = _make_logic(enabled=False)
    triggered = _arm_to_trigger(logic, hits=10)
    assert not triggered
    assert logic.state == 'idle'


def test_no_trigger_when_no_goal_and_goal_only_mode() -> None:
    logic = _make_logic(active_only_when_goal_active=True)
    inp = _qualifying_input(goal_active=False)
    for _ in range(10):
        assert not logic.update(inp, 0.0)
    assert logic.state == 'idle'


def test_triggers_without_goal_when_goal_only_mode_is_false() -> None:
    logic = _make_logic(
        active_only_when_goal_active=False,
        required_consecutive_hits=2,
    )
    inp = _qualifying_input(goal_active=False)
    logic.update(inp, 0.0)
    triggered = logic.update(inp, 0.1)
    assert triggered


def test_no_trigger_in_manual_when_active_in_manual_is_false() -> None:
    logic = _make_logic(active_in_manual=False)
    inp = _qualifying_input(manual_enabled=True)
    for _ in range(10):
        assert not logic.update(inp, 0.0)
    assert logic.state == 'idle'


def test_triggers_in_manual_when_active_in_manual_is_true() -> None:
    # active_only_when_goal_active must also be False, otherwise goal check fires first
    logic = _make_logic(
        active_in_manual=True,
        active_only_when_goal_active=False,
        required_consecutive_hits=2,
    )
    inp = _qualifying_input(manual_enabled=True, goal_active=False)
    logic.update(inp, 0.0)
    triggered = logic.update(inp, 0.1)
    assert triggered


# ---------------------------------------------------------------------------
# Target quality gates
# ---------------------------------------------------------------------------

def test_no_trigger_when_not_fresh() -> None:
    logic = _make_logic()
    inp = _qualifying_input(fresh=False)
    for _ in range(5):
        assert not logic.update(inp, 0.0)


def test_no_trigger_when_not_available() -> None:
    logic = _make_logic()
    inp = _qualifying_input(available=False)
    for _ in range(5):
        assert not logic.update(inp, 0.0)


def test_no_trigger_when_label_not_in_list() -> None:
    logic = _make_logic(trigger_labels=['person'])
    inp = _qualifying_input(label='bicycle')
    for _ in range(5):
        assert not logic.update(inp, 0.0)


def test_label_matching_is_case_insensitive() -> None:
    logic = _make_logic(trigger_labels=['Person'], required_consecutive_hits=1)
    inp = _qualifying_input(label='PERSON', score=0.9, area_norm=0.1)
    triggered = logic.update(inp, 0.0)
    assert triggered


def test_no_trigger_when_score_below_threshold() -> None:
    logic = _make_logic(min_score=0.70)
    inp = _qualifying_input(score=0.65)
    for _ in range(5):
        assert not logic.update(inp, 0.0)


def test_no_trigger_when_area_below_threshold() -> None:
    logic = _make_logic(min_area_norm=0.05)
    inp = _qualifying_input(area_norm=0.03)
    for _ in range(5):
        assert not logic.update(inp, 0.0)


def test_empty_trigger_labels_matches_any_label() -> None:
    logic = _make_logic(trigger_labels=[], required_consecutive_hits=1)
    inp = _qualifying_input(label='unknown_class')
    triggered = logic.update(inp, 0.0)
    assert triggered


# ---------------------------------------------------------------------------
# Debounce: required_consecutive_hits
# ---------------------------------------------------------------------------

def test_no_trigger_before_required_hits() -> None:
    n = 4
    logic = _make_logic(required_consecutive_hits=n)
    for i in range(n - 1):
        result = logic.update(_qualifying_input(), float(i))
        assert not result, f'should not trigger at hit {i + 1}'
    assert logic.state == 'arming'
    assert logic.hit_count == n - 1


def test_triggers_exactly_at_required_hits() -> None:
    n = 3
    logic = _make_logic(required_consecutive_hits=n)
    result = _arm_to_trigger(logic, hits=n)
    assert result
    assert logic.state == 'cooldown'


def test_hit_counter_resets_when_target_disappears() -> None:
    logic = _make_logic(required_consecutive_hits=4)
    # Two valid hits
    logic.update(_qualifying_input(), 0.0)
    logic.update(_qualifying_input(), 0.1)
    assert logic.hit_count == 2

    # Target goes stale
    logic.update(_qualifying_input(fresh=False), 0.2)
    assert logic.hit_count == 0
    assert logic.state == 'idle'

    # Counter restarts from zero
    logic.update(_qualifying_input(), 0.3)
    assert logic.hit_count == 1


def test_state_is_arming_while_accumulating() -> None:
    logic = _make_logic(required_consecutive_hits=5)
    logic.update(_qualifying_input(), 0.0)
    assert logic.state == 'arming'
    logic.update(_qualifying_input(), 0.1)
    assert logic.state == 'arming'
    assert logic.hit_count == 2


# ---------------------------------------------------------------------------
# Cooldown
# ---------------------------------------------------------------------------

def test_cooldown_blocks_immediate_retrigger() -> None:
    n = 2
    logic = _make_logic(required_consecutive_hits=n, retrigger_cooldown_s=5.0)
    _arm_to_trigger(logic, hits=n, now=0.0)
    assert logic.state == 'cooldown'

    # Feed valid target but cooldown hasn't expired
    for t in [0.5, 1.0, 2.0, 4.9]:
        triggered = logic.update(_qualifying_input(), t)
        assert not triggered, f'should not retrigger at t={t}'


def test_cooldown_allows_retrigger_after_interval() -> None:
    n = 2
    cooldown = 5.0
    # _arm_to_trigger fires the brake at t = (n-1)*0.1 = 0.1 (last iteration)
    trigger_time = (n - 1) * 0.1
    logic = _make_logic(required_consecutive_hits=n, retrigger_cooldown_s=cooldown)
    _arm_to_trigger(logic, hits=n, now=0.0)

    expiry = trigger_time + cooldown  # 5.1

    # Still in cooldown just before expiry
    assert not logic.update(_qualifying_input(), expiry - 0.01)

    # At and past expiry
    retriggered = logic.update(_qualifying_input(), expiry)
    assert retriggered


def test_cooldown_resets_when_target_disappears() -> None:
    n = 2
    logic = _make_logic(required_consecutive_hits=n, retrigger_cooldown_s=5.0)
    _arm_to_trigger(logic, hits=n, now=0.0)
    assert logic.state == 'cooldown'

    # Target disappears (not fresh)
    logic.update(_qualifying_input(fresh=False), 1.0)
    assert logic.state == 'idle'
    assert logic.hit_count == 0

    # After returning, needs to re-arm from scratch (no cooldown remaining)
    logic.update(_qualifying_input(), 2.0)
    assert logic.state == 'arming'
    assert logic.hit_count == 1

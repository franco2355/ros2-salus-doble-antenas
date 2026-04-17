"""
Pure logic for the vision brake guard — no ROS dependency.

Importable without rclpy for unit testing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import FrozenSet, Optional, Sequence


@dataclass(frozen=True)
class GuardInput:
    """Snapshot of the current target + nav state, passed to VisionBrakeGuardLogic."""
    fresh: bool
    available: bool
    label: str
    score: float
    area_norm: float          # width_norm * height_norm from VisionTarget
    goal_active: bool
    manual_enabled: bool


class VisionBrakeGuardLogic:
    """
    Stateful logic for the vision brake guard.

    States
    ------
    idle     : no qualifying target or guard not active
    arming   : qualifying target present, accumulating consecutive hits
    cooldown : brake was fired; waiting for retrigger_cooldown_s before a new
               brake call is allowed (target must still be present)

    Invariant
    ---------
    ``_reset()`` always returns to IDLE and clears the cooldown timer.
    Calling ``update()`` with any non-qualifying input always calls ``_reset()``.

    Parameters
    ----------
    trigger_labels
        Labels that activate the guard. Empty list = match any label.
    min_score
        Minimum detection confidence to qualify.
    min_area_norm
        Minimum bounding-box area (width_norm * height_norm) to qualify.
        Used as a proximity proxy: a large bbox = close object.
    required_consecutive_hits
        Number of consecutive qualifying samples before the brake fires.
    retrigger_cooldown_s
        Seconds to wait after a brake before allowing a new one, while the
        same target is still present.
    enabled
        Master switch. When False, no brake is ever triggered.
    active_only_when_goal_active
        If True, guard is dormant unless nav_command_server reports a
        goal currently being executed.
    active_in_manual
        If False (default), guard is dormant while manual control is active.
    """

    def __init__(
        self,
        *,
        trigger_labels: Sequence[str],
        min_score: float,
        min_area_norm: float,
        required_consecutive_hits: int,
        retrigger_cooldown_s: float,
        enabled: bool,
        active_only_when_goal_active: bool,
        active_in_manual: bool,
    ) -> None:
        self._trigger_labels: FrozenSet[str] = frozenset(
            lbl.strip().lower() for lbl in trigger_labels if str(lbl).strip()
        )
        self._min_score = float(min_score)
        self._min_area_norm = float(min_area_norm)
        self._required_consecutive_hits = max(1, int(required_consecutive_hits))
        self._retrigger_cooldown_s = max(0.0, float(retrigger_cooldown_s))
        self._enabled = bool(enabled)
        self._active_only_when_goal_active = bool(active_only_when_goal_active)
        self._active_in_manual = bool(active_in_manual)

        self._hit_count: int = 0
        self._in_cooldown: bool = False
        self._last_brake_time: Optional[float] = None

    # -- public read-only state -----------------------------------------------

    @property
    def state(self) -> str:
        """Current state name: 'idle' | 'arming' | 'cooldown'."""
        if self._in_cooldown:
            return 'cooldown'
        if self._hit_count > 0:
            return 'arming'
        return 'idle'

    @property
    def hit_count(self) -> int:
        return self._hit_count

    @property
    def enabled(self) -> bool:
        return self._enabled

    # -- main entry point -----------------------------------------------------

    def update(self, inp: GuardInput, now: float) -> bool:
        """
        Process one VisionTarget sample.

        Parameters
        ----------
        inp : GuardInput  — snapshot of the current target + nav state
        now : float       — monotonic timestamp (seconds)

        Returns
        -------
        True  when the brake service should be called (rising edge only).
        False otherwise.
        """
        # --- global enable guards -------------------------------------------
        if not self._enabled:
            self._reset()
            return False

        if self._active_only_when_goal_active and not inp.goal_active:
            self._reset()
            return False

        if not self._active_in_manual and inp.manual_enabled:
            self._reset()
            return False

        # --- target quality gates -------------------------------------------
        label_ok = (
            not self._trigger_labels           # empty list → match any label
            or inp.label.strip().lower() in self._trigger_labels
        )
        conditions_met = (
            inp.fresh
            and inp.available
            and label_ok
            and inp.score >= self._min_score
            and inp.area_norm >= self._min_area_norm
        )

        if not conditions_met:
            self._reset()
            return False

        # --- state machine: conditions are met ------------------------------
        if self._in_cooldown:
            elapsed = now - (self._last_brake_time or now)
            if elapsed >= self._retrigger_cooldown_s:
                self._last_brake_time = now
                return True
            return False

        # ARMING: accumulate consecutive hits
        self._hit_count += 1
        if self._hit_count >= self._required_consecutive_hits:
            self._in_cooldown = True
            self._last_brake_time = now
            return True

        return False

    def _reset(self) -> None:
        self._hit_count = 0
        self._in_cooldown = False
        self._last_brake_time = None

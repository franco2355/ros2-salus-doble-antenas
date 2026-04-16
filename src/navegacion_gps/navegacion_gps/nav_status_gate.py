from __future__ import annotations

from typing import Iterable


ACTIVE_GOAL_STATUSES = frozenset({1, 2, 3})


def has_active_goal_status(statuses: Iterable[int]) -> bool:
    return any(int(status) in ACTIVE_GOAL_STATUSES for status in statuses)


def effective_goal_active(
    *,
    internal_active: bool,
    external_active: bool,
    external_age_s: float | None,
    external_timeout_s: float,
) -> bool:
    if bool(internal_active):
        return True
    if not bool(external_active):
        return False
    if external_age_s is None:
        return False
    return float(external_age_s) <= max(0.0, float(external_timeout_s))

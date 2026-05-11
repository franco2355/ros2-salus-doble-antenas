import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from navegacion_gps.nav_status_gate import effective_goal_active  # noqa: E402
from navegacion_gps.nav_status_gate import has_active_goal_status  # noqa: E402


def test_has_active_goal_status_detects_executing_like_states() -> None:
    assert has_active_goal_status([2]) is True
    assert has_active_goal_status([4, 5]) is False
    assert has_active_goal_status([6, 3]) is True


def test_effective_goal_active_keeps_internal_goal_priority() -> None:
    assert (
        effective_goal_active(
            internal_active=True,
            external_active=False,
            external_age_s=None,
            external_timeout_s=1.0,
        )
        is True
    )


def test_effective_goal_active_accepts_fresh_external_nav() -> None:
    assert (
        effective_goal_active(
            internal_active=False,
            external_active=True,
            external_age_s=0.25,
            external_timeout_s=1.0,
        )
        is True
    )


def test_effective_goal_active_rejects_stale_external_nav() -> None:
    assert (
        effective_goal_active(
            internal_active=False,
            external_active=True,
            external_age_s=2.0,
            external_timeout_s=1.0,
        )
        is False
    )

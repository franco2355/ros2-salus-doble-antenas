"""
Tests for cmd_vel_angular_smoother.

All tests are pure Python — zero ROS dependencies — so they run in <1 s
with a plain `pytest`.

The anti-oscillation claim being tested:
    A sinusoidal angular.z input at 2 Hz (typical RPP wobble frequency)
    must be attenuated by at least 50 % in RMS amplitude after passing
    through the smoother.  The RC time constant tau=0.20 s gives
    ~9 dB attenuation at 2 Hz, so this threshold is conservative.
"""
from __future__ import annotations

import math

from navegacion_gps.cmd_vel_angular_smoother import AngularZSmoother, process_twist

try:
    from geometry_msgs.msg import Twist as _RosTwist  # available in build env
    _HAVE_ROS = True
except ImportError:
    _HAVE_ROS = False

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_twist(linear_x: float = 0.0, angular_z: float = 0.0):
    """Build a minimal Twist-like object that works with or without ROS."""
    if _HAVE_ROS:
        from geometry_msgs.msg import Twist
        t = Twist()
        t.linear.x = linear_x
        t.angular.z = angular_z
        return t
    # Minimal stub when geometry_msgs is not installed
    class _V:
        def __init__(self, **kw):
            for k, v in kw.items():
                setattr(self, k, v)
    t = type("Twist", (), {})()
    t.linear = _V(x=linear_x, y=0.0, z=0.0)
    t.angular = _V(x=0.0, y=0.0, z=angular_z)
    return t


# ---------------------------------------------------------------------------
# Unit tests: AngularZSmoother logic
# ---------------------------------------------------------------------------

def test_cold_start_returns_raw_value() -> None:
    """First sample must be accepted as-is (no slow ramp from zero)."""
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=1.5)
    out = smoother.update(0.4, dt=0.05)
    assert math.isclose(out, 0.4, abs_tol=1e-9)


def test_zero_input_stays_zero() -> None:
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=1.5)
    for _ in range(20):
        out = smoother.update(0.0, dt=0.05)
    assert math.isclose(out, 0.0, abs_tol=1e-9)


def test_step_response_converges_to_setpoint() -> None:
    """After enough steps, the output must reach the constant input."""
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=10.0)  # generous rate
    target = 0.35
    dt = 0.05
    for _ in range(100):  # 5 s >> tau
        out = smoother.update(target, dt=dt)
    assert math.isclose(out, target, abs_tol=1e-4), \
        f"Expected ~{target}, got {out:.6f}"


def test_step_response_no_overshoot() -> None:
    """RC filter must be monotone — output must never exceed the target."""
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=10.0)
    target = 0.4
    dt = 0.05
    prev = 0.0
    for _ in range(60):
        out = smoother.update(target, dt=dt)
        assert out <= target + 1e-9, f"Overshoot at {out:.6f} > {target}"
        assert out >= prev - 1e-9, f"Non-monotone dip at {out:.6f} < {prev:.6f}"
        prev = out


def test_rate_limit_respected_on_step() -> None:
    """
    A large step input must be rate-limited: change per step ≤ max_rate * dt.
    """
    max_rate = 1.5       # rad/s²
    dt = 0.05            # 20 Hz
    max_delta = max_rate * dt   # = 0.075 rad/s per step
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=max_rate)

    smoother.update(0.0, dt=dt)          # initialise at 0
    out = smoother.update(0.4, dt=dt)    # large step

    # The first filtered step after init must be ≤ max_delta
    assert abs(out) <= max_delta + 1e-9, \
        f"Rate limit violated: Δω = {abs(out):.4f} > {max_delta:.4f} rad/s"


def test_oscillation_is_damped_by_at_least_50_pct() -> None:
    """
    Core anti-oscillation test.

    Drive the filter with a 2 Hz sine wave for 3 s at 20 Hz sample rate.
    The output RMS must be ≤ 50 % of the input RMS.

    Theory: RC LP at tau=0.20 s, ω_c = 1/tau = 5 rad/s (~0.8 Hz).
    Gain at 2 Hz (12.6 rad/s): |H| = ωc / sqrt(ωc² + ω²) ≈ 0.37 → ~63 %
    attenuation.  50 % is a conservative threshold.
    """
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=10.0)  # only LP, big rate budget

    freq_hz = 2.0
    amp = 0.4           # rad/s
    dt = 0.05           # 20 Hz
    n_steps = int(3.0 / dt)  # 3 s

    input_sq_sum = 0.0
    output_sq_sum = 0.0

    for k in range(n_steps):
        t = k * dt
        raw = amp * math.sin(2.0 * math.pi * freq_hz * t)
        out = smoother.update(raw, dt=dt)
        input_sq_sum += raw ** 2
        output_sq_sum += out ** 2

    rms_in = math.sqrt(input_sq_sum / n_steps)
    rms_out = math.sqrt(output_sq_sum / n_steps)

    # The output must be at most 50 % of the input amplitude.
    assert rms_out <= 0.50 * rms_in, (
        f"Oscillation NOT sufficiently damped: "
        f"rms_in={rms_in:.4f}  rms_out={rms_out:.4f}  "
        f"ratio={rms_out/rms_in:.2f} (must be ≤ 0.50)"
    )


def test_reset_clears_state() -> None:
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=1.5)
    smoother.update(0.4, dt=0.05)
    assert smoother.state is not None

    smoother.reset()
    assert smoother.state is None

    # After reset, first sample is accepted raw again
    out = smoother.update(0.3, dt=0.05)
    assert math.isclose(out, 0.3, abs_tol=1e-9)


def test_linear_x_is_not_modified() -> None:
    """linear.x must be passed through unchanged regardless of filtering."""
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=1.5)
    msg = _make_twist(linear_x=1.2, angular_z=0.3)
    out = process_twist(smoother, msg, dt=0.05)
    assert math.isclose(out.linear.x, 1.2, abs_tol=1e-9)


def test_alternating_sign_input_output_amplitude_bounded() -> None:
    """
    Worst-case: input alternates +max / -max every sample (square wave at
    Nyquist).  Steady-state output amplitude must stay well below max_input.

    The cold-start intentionally accepts the very first sample as-is so the
    vehicle doesn't lurch from zero.  We therefore warm up the filter at zero
    first, THEN feed the alternating wave and measure the steady-state peak.
    """
    smoother = AngularZSmoother(tau_s=0.20, max_rate_rps2=1.5)
    amp = 0.4
    dt = 0.05

    # Warm-up at zero so the initial state is 0 (not the first oscillation sample).
    for _ in range(5):
        smoother.update(0.0, dt=dt)

    # Now drive with Nyquist square wave and measure steady-state peak.
    max_out = 0.0
    for k in range(40):
        raw = amp if k % 2 == 0 else -amp
        out = smoother.update(raw, dt=dt)
        max_out = max(max_out, abs(out))

    # Rate limiter alone: max change per step = 1.5 * 0.05 = 0.075 rad/s.
    # Starting from 0 and alternating ±0.4, steady-state peak converges to
    # the rate-limit bound ~0.075 rad/s.  Using 0.15 rad/s as threshold
    # (2× budget) to be robust to the first few transient cycles.
    assert max_out < 0.15, (
        f"Square-wave oscillation not damped: peak={max_out:.3f} rad/s "
        f"(expected < 0.15 rad/s)"
    )

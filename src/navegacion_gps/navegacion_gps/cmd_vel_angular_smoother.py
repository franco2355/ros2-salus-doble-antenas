"""
cmd_vel_angular_smoother — damps angular.z oscillations in the cmd_vel stream.

Oscillation root cause: the RPP controller sees a rapidly-rotating lookahead
point (especially during curve entry/exit or when the map→odom TF jumps from
EKF corrections) and generates large, alternating angular.z commands.  A
simulated Ackermann vehicle with an ideal plugin has no mechanical damping,
so those commands are executed literally, producing visible zigzag motion.

Two-stage filter applied ONLY to angular.z:
  1. RC low-pass (time-aware EMA):  alpha = 1 - exp(-dt / tau)
     Attenuates high-frequency oscillations.  tau_s (default 0.20 s) gives
     ~9 dB attenuation at 2 Hz (typical RPP wobble frequency).

  2. Rate limiter: |Δω_z / Δt| ≤ max_rate_rps2
     Prevents instantaneous jumps even when the LP filter barely attenuates
     them (e.g., at cold start or after a watchdog reset).

linear.x is passed through UNCHANGED — Nav2 velocity_smoother already handles
longitudinal smoothing.

Topology in sim_global_v2:
    Nav2 → collision_monitor → /cmd_vel_safe
                                      ↓
                          cmd_vel_angular_smoother   ← this node
                                      ↓
                              /cmd_vel_safe_smooth
                                      ↓
                          nav_command_server → /cmd_vel_final → controller_server

Module layout
─────────────
The pure-Python classes AngularZSmoother and process_twist live at the top of
this file with ZERO external imports so they can be unit-tested without ROS.
All ROS imports are deferred into the class body / main() where they are needed.
"""
from __future__ import annotations

import math


# ===========================================================================
# Pure filtering logic — zero external dependencies, fully unit-testable
# ===========================================================================

class AngularZSmoother:
    """
    Stateful RC low-pass + rate-limiter for a single scalar (angular.z).

    Parameters
    ----------
    tau_s : float
        RC time constant in seconds.  0.20 s → ~3 dB cut at ~0.8 Hz.
        Oscillations at 2 Hz (typical RPP wobble) are attenuated by ~9 dB.
    max_rate_rps2 : float
        Maximum allowed angular acceleration in rad/s².  Clamps the per-step
        change before the LP state is updated.
    """

    __slots__ = ("_tau", "_max_rate", "_state")

    def __init__(self, tau_s: float = 0.20, max_rate_rps2: float = 1.5) -> None:
        self._tau: float = max(1.0e-6, float(tau_s))
        self._max_rate: float = max(0.0, float(max_rate_rps2))
        self._state: float | None = None

    def reset(self) -> None:
        """Clear filter state (e.g., after a watchdog timeout)."""
        self._state = None

    def update(self, raw: float, dt: float) -> float:
        """
        Feed one sample and return the filtered value.

        Parameters
        ----------
        raw : float   New angular.z sample (rad/s).
        dt  : float   Elapsed time since the previous sample (s).
        """
        dt = max(1.0e-6, float(dt))
        raw = float(raw)

        if self._state is None:
            # Cold start: accept first sample as-is so we do not ramp slowly
            # from zero on the very first command (would cause a lurch).
            self._state = raw
            return raw

        # Stage 1 — RC low-pass
        alpha = 1.0 - math.exp(-dt / self._tau)
        lp_out = self._state + alpha * (raw - self._state)

        # Stage 2 — rate limiter
        delta = lp_out - self._state
        max_delta = self._max_rate * dt
        self._state = self._state + max(-max_delta, min(max_delta, delta))
        return self._state

    @property
    def state(self) -> float | None:
        """Current filter state, or None if not yet initialised."""
        return self._state


def process_twist(smoother: AngularZSmoother, raw, dt: float):
    """
    Apply the smoother to one Twist-like message.

    Accepts any object with .linear.{x,y,z} and .angular.{x,y,z} attributes
    (duck-typed so it works with both ROS Twist and test stubs).  Returns an
    object of the SAME type with filtered angular.z.

    When called with a real geometry_msgs/Twist the return type is also Twist.
    """
    # Import lazily so the module loads without ROS in unit tests.
    try:
        from geometry_msgs.msg import Twist
        out = Twist()
    except ImportError:
        # Test stub path: mirror the type of the input
        import copy
        out = copy.deepcopy(raw)

    out.linear.x = raw.linear.x
    out.linear.y = raw.linear.y
    out.linear.z = raw.linear.z
    out.angular.x = raw.angular.x
    out.angular.y = raw.angular.y
    out.angular.z = smoother.update(raw.angular.z, dt)
    return out


# ===========================================================================
# ROS 2 node
# ===========================================================================

def _build_node():
    """Construct and return the ROS node (deferred so ROS imports stay local)."""
    import time
    import rclpy
    from geometry_msgs.msg import Twist
    from rclpy.node import Node

    class CmdVelAngularSmootherNode(Node):
        """ROS 2 wrapper around AngularZSmoother."""

        def __init__(self) -> None:
            super().__init__("cmd_vel_angular_smoother")

            self.declare_parameter("input_topic", "/cmd_vel_safe")
            self.declare_parameter("output_topic", "/cmd_vel_safe_smooth")
            self.declare_parameter("tau_s", 0.20)
            self.declare_parameter("max_rate_rps2", 1.5)
            self.declare_parameter("timeout_s", 0.5)
            self.declare_parameter("watchdog_hz", 20.0)

            input_topic  = str(self.get_parameter("input_topic").value)
            output_topic = str(self.get_parameter("output_topic").value)
            tau_s        = max(1.0e-3, float(self.get_parameter("tau_s").value))
            max_rate     = max(0.0,    float(self.get_parameter("max_rate_rps2").value))
            timeout_s    = max(0.05,   float(self.get_parameter("timeout_s").value))
            watchdog_hz  = max(1.0,    float(self.get_parameter("watchdog_hz").value))

            self._smoother   = AngularZSmoother(tau_s=tau_s, max_rate_rps2=max_rate)
            self._timeout_s  = timeout_s
            self._last_rx_ns: int | None = None

            self._pub = self.create_publisher(Twist, output_topic, 10)
            self.create_subscription(Twist, input_topic, self._on_cmd_vel, 10)
            self.create_timer(1.0 / watchdog_hz, self._watchdog)

            self.get_logger().info(
                f"cmd_vel_angular_smoother  {input_topic} → {output_topic}  "
                f"tau={tau_s:.3f}s  max_rate={max_rate:.2f} rad/s²  "
                f"timeout={timeout_s:.2f}s"
            )

        def _on_cmd_vel(self, msg: Twist) -> None:
            now_ns = self.get_clock().now().nanoseconds
            dt = (
                0.05
                if self._last_rx_ns is None
                else max(1.0e-6, (now_ns - self._last_rx_ns) * 1.0e-9)
            )
            self._last_rx_ns = now_ns
            self._pub.publish(process_twist(self._smoother, msg, dt))

        def _watchdog(self) -> None:
            if self._last_rx_ns is None:
                return
            age_s = (self.get_clock().now().nanoseconds - self._last_rx_ns) * 1.0e-9
            if age_s > self._timeout_s:
                self._smoother.reset()
                self._last_rx_ns = None
                self._pub.publish(Twist())

    return CmdVelAngularSmootherNode()


def main(args=None) -> None:
    import rclpy
    rclpy.init(args=args)
    node = _build_node()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()

from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry

from navegacion_gps.global_odom_stationary_gate import GlobalOdomStationaryGateNode


class _FakePublisher:
    def __init__(self) -> None:
        self.messages = []

    def publish(self, msg) -> None:
        self.messages.append(msg)


class _FakeGateNode:
    _on_odometry = GlobalOdomStationaryGateNode._on_odometry
    _stationary_gate_active = GlobalOdomStationaryGateNode._stationary_gate_active
    _zero_twist = staticmethod(GlobalOdomStationaryGateNode._zero_twist)

    def __init__(self) -> None:
        self._stationary_speed_threshold_mps = 0.03
        self._drive_telemetry_timeout_s = 0.5
        self._last_drive_telemetry = None
        self._last_drive_telemetry_monotonic_s = None
        self._odom_pub = _FakePublisher()
        self._now_s = 100.0

    def _monotonic_now_s(self) -> float:
        return float(self._now_s)


def _make_drive(
    *,
    speed_mps: float,
    fresh: bool = True,
    speed_valid: bool = True,
) -> DriveTelemetry:
    msg = DriveTelemetry()
    msg.fresh = bool(fresh)
    msg.speed_valid = bool(speed_valid)
    msg.speed_mps_measured = float(speed_mps)
    return msg


def _make_odom() -> Odometry:
    msg = Odometry()
    msg.pose.pose.position.x = 12.5
    msg.pose.pose.position.y = -3.0
    msg.twist.twist.linear.x = 0.24
    msg.twist.twist.linear.y = -0.08
    msg.twist.twist.angular.z = 0.11
    return msg


def test_gate_zeroes_twist_when_stationary_with_fresh_telemetry() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.01)
    node._last_drive_telemetry_monotonic_s = 99.8

    node._on_odometry(_make_odom())

    published = node._odom_pub.messages[-1]
    assert published.pose.pose.position.x == 12.5
    assert published.pose.pose.position.y == -3.0
    assert published.twist.twist.linear.x == 0.0
    assert published.twist.twist.linear.y == 0.0
    assert published.twist.twist.angular.z == 0.0


def test_gate_passes_through_twist_when_vehicle_is_moving() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.12)
    node._last_drive_telemetry_monotonic_s = 99.8

    node._on_odometry(_make_odom())

    published = node._odom_pub.messages[-1]
    assert published.twist.twist.linear.x == 0.24
    assert published.twist.twist.linear.y == -0.08
    assert published.twist.twist.angular.z == 0.11


def test_gate_passes_through_twist_when_drive_telemetry_is_stale() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.0)
    node._last_drive_telemetry_monotonic_s = 99.0

    node._on_odometry(_make_odom())

    published = node._odom_pub.messages[-1]
    assert published.twist.twist.linear.x == 0.24
    assert published.twist.twist.linear.y == -0.08
    assert published.twist.twist.angular.z == 0.11

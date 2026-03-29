from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry

from navegacion_gps.global_yaw_stationary_hold import GlobalYawStationaryHoldNode


class _FakePublisher:
    def __init__(self) -> None:
        self.messages = []

    def publish(self, msg) -> None:
        self.messages.append(msg)


class _FakeGateNode:
    _on_odometry = GlobalYawStationaryHoldNode._on_odometry
    _stationary_gate_active = GlobalYawStationaryHoldNode._stationary_gate_active
    _orientation_is_finite = staticmethod(GlobalYawStationaryHoldNode._orientation_is_finite)
    _make_large_diagonal_covariance = staticmethod(
        GlobalYawStationaryHoldNode._make_large_diagonal_covariance
    )
    _yaw_only_measurement = GlobalYawStationaryHoldNode._yaw_only_measurement

    def __init__(self) -> None:
        self._stationary_speed_threshold_mps = 0.03
        self._drive_telemetry_timeout_s = 0.5
        self._yaw_variance_rad2 = 0.01
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
    msg.pose.pose.orientation.z = 0.24740395925452294
    msg.pose.pose.orientation.w = 0.9689124217106447
    return msg


def test_hold_publishes_yaw_only_measurement_when_stationary() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.01)
    node._last_drive_telemetry_monotonic_s = 99.8

    node._on_odometry(_make_odom())

    published = node._odom_pub.messages[-1]
    assert published.pose.pose.orientation.z == 0.24740395925452294
    assert published.pose.pose.orientation.w == 0.9689124217106447
    assert published.pose.covariance[0] == 1.0e6
    assert published.pose.covariance[7] == 1.0e6
    assert published.pose.covariance[35] == 0.01


def test_hold_suppresses_measurement_when_vehicle_is_moving() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.12)
    node._last_drive_telemetry_monotonic_s = 99.8

    node._on_odometry(_make_odom())

    assert node._odom_pub.messages == []


def test_hold_suppresses_measurement_when_drive_telemetry_is_stale() -> None:
    node = _FakeGateNode()
    node._last_drive_telemetry = _make_drive(speed_mps=0.0)
    node._last_drive_telemetry_monotonic_s = 99.0

    node._on_odometry(_make_odom())

    assert node._odom_pub.messages == []

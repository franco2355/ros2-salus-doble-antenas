from sensor_msgs.msg import NavSatFix

from navegacion_gps.gps_profiles import SimGpsFixProcessor, resolve_gps_profile
from navegacion_gps.sim_sensor_normalizer_v2 import SimSensorNormalizerV2Node


class _FakePublisher:
    def __init__(self) -> None:
        self.messages = []

    def publish(self, msg) -> None:
        self.messages.append(msg)


class _FakeNormalizerNode:
    _on_gps = SimSensorNormalizerV2Node._on_gps
    _should_hold_gps = SimSensorNormalizerV2Node._should_hold_gps

    def __init__(self, profile_name: str, *, hold_when_stationary: bool = False) -> None:
        self._gps_frame_id = "gps_link"
        self._gps_processor = SimGpsFixProcessor(
            resolve_gps_profile(profile_name), random_seed=123
        )
        self._gps_profile = self._gps_processor.profile
        self._gps_hold_when_stationary = hold_when_stationary
        self._gps_hold_linear_speed_threshold_mps = 0.02
        self._gps_hold_yaw_rate_threshold_rps = 0.01
        self._last_odom_linear_speed_mps = 0.0
        self._last_odom_yaw_rate_rps = 0.0
        self._last_gps_out = None
        self._gps_pub = _FakePublisher()
        self._gps_rtk_status_pub = _FakePublisher()


def _make_fix(sec: int = 10, nanosec: int = 0) -> NavSatFix:
    msg = NavSatFix()
    msg.header.stamp.sec = sec
    msg.header.stamp.nanosec = nanosec
    msg.header.frame_id = "model::gps_link"
    msg.latitude = -31.4858037
    msg.longitude = -64.2410570
    msg.altitude = 0.0
    return msg


def test_sim_sensor_normalizer_ideal_profile_is_passthrough() -> None:
    node = _FakeNormalizerNode("ideal")
    msg = _make_fix()

    node._on_gps(msg)

    assert len(node._gps_pub.messages) == 1
    published = node._gps_pub.messages[-1]
    assert published.header.frame_id == "gps_link"
    assert published.latitude == msg.latitude
    assert published.longitude == msg.longitude
    assert node._gps_rtk_status_pub.messages[-1].data == "SIM_IDEAL"


def test_sim_sensor_normalizer_m8n_profile_throttles_and_publishes_status() -> None:
    node = _FakeNormalizerNode("m8n")

    node._on_gps(_make_fix(sec=10, nanosec=0))
    node._on_gps(_make_fix(sec=10, nanosec=50_000_000))
    node._on_gps(_make_fix(sec=10, nanosec=250_000_000))

    assert len(node._gps_pub.messages) == 2
    assert node._gps_rtk_status_pub.messages[-1].data == "3D_FIX"


def test_sim_sensor_normalizer_holds_f9p_rtk_when_stationary() -> None:
    node = _FakeNormalizerNode("f9p_rtk", hold_when_stationary=True)

    node._on_gps(_make_fix(sec=10, nanosec=0))
    first = node._gps_pub.messages[-1]
    node._on_gps(_make_fix(sec=10, nanosec=100_000_000))
    second = node._gps_pub.messages[-1]

    assert len(node._gps_pub.messages) == 2
    assert second.latitude == first.latitude
    assert second.longitude == first.longitude
    assert second.altitude == first.altitude
    assert second.header.stamp.sec == 10
    assert second.header.stamp.nanosec == 100_000_000


def test_sim_sensor_normalizer_holds_ideal_when_stationary() -> None:
    node = _FakeNormalizerNode("ideal", hold_when_stationary=True)

    node._on_gps(_make_fix(sec=20, nanosec=0))
    first = node._gps_pub.messages[-1]
    node._on_gps(_make_fix(sec=20, nanosec=100_000_000))
    second = node._gps_pub.messages[-1]

    assert len(node._gps_pub.messages) == 2
    assert second.latitude == first.latitude
    assert second.longitude == first.longitude
    assert second.altitude == first.altitude
    assert second.header.stamp.nanosec == 100_000_000

from geometry_msgs.msg import Point
from nav_msgs.msg import Odometry
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix

from navegacion_gps.map_gps_absolute_measurement import MapGpsAbsoluteMeasurementNode


class _FakePublisher:
    def __init__(self) -> None:
        self.messages = []

    def publish(self, msg) -> None:
        self.messages.append(msg)


class _FakeLogger:
    def __init__(self) -> None:
        self.infos = []
        self.warnings = []

    def info(self, msg: str) -> None:
        self.infos.append(msg)

    def warning(self, msg: str) -> None:
        self.warnings.append(msg)


class _FakeClient:
    def __init__(self, *, available: bool) -> None:
        self.available = available

    def wait_for_service(self, timeout_sec: float) -> bool:
        return bool(self.available)


class _FakeFuture:
    def __init__(self, response=None, exception=None) -> None:
        self._response = response
        self._exception = exception

    def result(self):
        if self._exception is not None:
            raise self._exception
        return self._response


class _FakeNode:
    _is_valid_fix = staticmethod(MapGpsAbsoluteMeasurementNode._is_valid_fix)
    _apply_base_to_gps_offset = staticmethod(
        MapGpsAbsoluteMeasurementNode._apply_base_to_gps_offset
    )
    _build_odometry_message = staticmethod(MapGpsAbsoluteMeasurementNode._build_odometry_message)
    _gps_frame_candidates = MapGpsAbsoluteMeasurementNode._gps_frame_candidates
    _correct_map_point_to_base_frame = (
        MapGpsAbsoluteMeasurementNode._correct_map_point_to_base_frame
    )
    _resolve_fromll_client = MapGpsAbsoluteMeasurementNode._resolve_fromll_client
    _handle_fromll_result = MapGpsAbsoluteMeasurementNode._handle_fromll_result
    _on_fromll_done = MapGpsAbsoluteMeasurementNode._on_fromll_done
    _on_gps_fix = MapGpsAbsoluteMeasurementNode._on_gps_fix

    def __init__(self) -> None:
        self.map_frame = "map"
        self.pose_covariance_xy = 0.05
        self.fromll_service = "/fromLL"
        self.fromll_service_fallback = "/navsat_transform/fromLL"
        self.fromll_wait_timeout_s = 0.2
        self.base_frame = "base_footprint"
        self.odom_topic = "/odometry/local"
        self.gps_frame_id_fallback = "gps_link"
        self._fromll_client = _FakeClient(available=True)
        self._fromll_fallback_client = _FakeClient(available=True)
        self._active_fromll_client = None
        self._active_fromll_name = None
        self._pending_future = None
        self._pending_fix = None
        self._queued_fix = None
        self._latest_base_yaw_rad = None
        self._missing_base_yaw_warned = False
        self._missing_gps_tf_warned = set()
        self.mount_offset = None
        self._odom_pub = _FakePublisher()
        self._logger = _FakeLogger()
        self.requested_fixes = []

    def get_logger(self) -> _FakeLogger:
        return self._logger

    def _lookup_gps_mount_offset_xy(self, fix_msg: NavSatFix):
        return self.mount_offset

    def _request_fromll_for_fix(self, msg: NavSatFix) -> None:
        self.requested_fixes.append(msg)


def _make_fix() -> NavSatFix:
    msg = NavSatFix()
    msg.header.frame_id = "gps"
    msg.header.stamp.sec = 12
    msg.header.stamp.nanosec = 340
    msg.latitude = -31.4858037
    msg.longitude = -64.2410570
    msg.altitude = 0.0
    return msg


def test_build_odometry_message_sets_map_frame_and_xy_covariance() -> None:
    fix = _make_fix()

    out = MapGpsAbsoluteMeasurementNode._build_odometry_message(
        fix,
        map_frame="map",
        pose_covariance_xy=0.05,
        map_x=12.3,
        map_y=-4.5,
        map_z=0.7,
    )

    assert isinstance(out, Odometry)
    assert out.header.frame_id == "map"
    assert out.child_frame_id == ""
    assert out.pose.pose.position.x == 12.3
    assert out.pose.pose.position.y == -4.5
    assert out.pose.pose.position.z == 0.7
    assert out.pose.pose.orientation.w == 1.0
    assert out.pose.covariance[0] == 0.05
    assert out.pose.covariance[7] == 0.05
    assert out.pose.covariance[35] == 1.0e6


def test_resolve_fromll_client_uses_fallback_when_primary_is_unavailable() -> None:
    node = _FakeNode()
    node._fromll_client = _FakeClient(available=False)
    node._fromll_fallback_client = _FakeClient(available=True)

    client = node._resolve_fromll_client()

    assert client is node._fromll_fallback_client
    assert node._active_fromll_name == "/navsat_transform/fromLL"


def test_handle_fromll_result_publishes_absolute_map_odometry() -> None:
    node = _FakeNode()
    response = FromLL.Response()
    response.map_point = Point(x=1.25, y=-2.5, z=0.0)

    node._handle_fromll_result(_make_fix(), response)

    published = node._odom_pub.messages[-1]
    assert published.header.frame_id == "map"
    assert published.pose.pose.position.x == 1.25
    assert published.pose.pose.position.y == -2.5
    assert published.pose.covariance[0] == 0.05
    assert published.pose.covariance[7] == 0.05


def test_apply_base_to_gps_offset_reprojects_antenna_point_to_base() -> None:
    corrected_x, corrected_y = MapGpsAbsoluteMeasurementNode._apply_base_to_gps_offset(
        map_x=10.0,
        map_y=5.0,
        base_yaw_rad=0.0,
        base_to_gps_x=1.0,
        base_to_gps_y=0.25,
    )

    assert corrected_x == 9.0
    assert corrected_y == 4.75


def test_handle_fromll_result_compensates_mount_offset_when_yaw_is_available() -> None:
    node = _FakeNode()
    node.mount_offset = (1.0, 0.25)
    node._latest_base_yaw_rad = 0.0
    response = FromLL.Response()
    response.map_point = Point(x=1.25, y=-2.5, z=0.0)

    node._handle_fromll_result(_make_fix(), response)

    published = node._odom_pub.messages[-1]
    assert published.pose.pose.position.x == 0.25
    assert published.pose.pose.position.y == -2.75


def test_handle_fromll_result_defers_publish_until_yaw_is_available() -> None:
    node = _FakeNode()
    node.mount_offset = (1.0, 0.25)
    response = FromLL.Response()
    response.map_point = Point(x=1.25, y=-2.5, z=0.0)

    node._handle_fromll_result(_make_fix(), response)

    assert node._odom_pub.messages == []
    assert node._logger.warnings == [
        "No odometry yaw available yet; deferring absolute GPS map measurement"
    ]


def test_on_gps_fix_ignores_invalid_fix() -> None:
    node = _FakeNode()
    msg = _make_fix()
    msg.latitude = float("nan")

    node._on_gps_fix(msg)

    assert node.requested_fixes == []


def test_on_fromll_done_does_not_publish_when_conversion_fails() -> None:
    node = _FakeNode()
    node._pending_fix = _make_fix()
    node._pending_future = object()

    node._on_fromll_done(_FakeFuture(exception=RuntimeError("boom")))

    assert node._odom_pub.messages == []
    assert node._logger.warnings

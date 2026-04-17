import sys
from pathlib import Path

import yaml


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from navegacion_gps.manual_waypoint_recorder_core import GpsFixSample  # noqa: E402
from navegacion_gps.manual_waypoint_recorder_core import ManualWaypointRecorderCore  # noqa: E402
from navegacion_gps.manual_waypoint_recorder_core import OdomSnapshot  # noqa: E402
from navegacion_gps.manual_waypoint_recorder_core import covariance_0_or_inf  # noqa: E402
from navegacion_gps.manual_waypoint_recorder_core import save_recorded_waypoints_yaml  # noqa: E402


def _make_fix(*, lat: float, lon: float, covariance_0: float = 1.0) -> GpsFixSample:
    return GpsFixSample(
        lat=lat,
        lon=lon,
        status=0,
        covariance_0=covariance_0,
    )


class _AmbiguousBoolSequence(list):
    def __bool__(self) -> bool:
        raise ValueError("ambiguous truthiness")


def test_bad_fix_covariance_is_not_recorded() -> None:
    recorder = ManualWaypointRecorderCore(min_distance_m=3.0, max_covariance=4.0)

    result = recorder.process_fix(
        _make_fix(lat=-31.4858, lon=-64.2410, covariance_0=5.1),
        odom_snapshot=OdomSnapshot(x=0.0, y=0.0, yaw_deg=0.0),
    )

    assert result is None
    assert recorder.count == 0


def test_covariance_0_handles_ambiguous_truthiness_sequences() -> None:
    assert covariance_0_or_inf(_AmbiguousBoolSequence([1.25, 0.0])) == 1.25
    assert covariance_0_or_inf(_AmbiguousBoolSequence()) == float("inf")
    assert covariance_0_or_inf(None) == float("inf")


def test_fix_below_distance_threshold_is_not_added() -> None:
    recorder = ManualWaypointRecorderCore(min_distance_m=3.0, max_covariance=4.0)

    first = recorder.process_fix(
        _make_fix(lat=-31.4858000, lon=-64.2410000),
        odom_snapshot=OdomSnapshot(x=1.0, y=2.0, yaw_deg=10.0),
    )
    second = recorder.process_fix(
        _make_fix(lat=-31.4858005, lon=-64.2410000),
        odom_snapshot=OdomSnapshot(x=1.5, y=2.0, yaw_deg=10.0),
    )

    assert first is not None
    assert second is None
    assert recorder.count == 1


def test_fix_beyond_distance_threshold_is_added() -> None:
    recorder = ManualWaypointRecorderCore(min_distance_m=3.0, max_covariance=4.0)

    first = recorder.process_fix(
        _make_fix(lat=-31.4858000, lon=-64.2410000),
        odom_snapshot=OdomSnapshot(x=0.0, y=0.0, yaw_deg=0.0),
    )
    second = recorder.process_fix(
        _make_fix(lat=-31.4858350, lon=-64.2410000),
        odom_snapshot=OdomSnapshot(x=4.2, y=0.0, yaw_deg=12.5),
    )

    assert first is not None
    assert second is not None
    waypoint, distance_m = second
    assert waypoint["label"] == "wp_1"
    assert waypoint["x"] == 4.2
    assert waypoint["yaw_deg"] == 12.5
    assert distance_m >= 3.0
    assert recorder.count == 2


def test_save_yaml_uses_expected_schema(tmp_path: Path) -> None:
    output_file = tmp_path / "recorded_waypoints.yaml"
    recorder = ManualWaypointRecorderCore(min_distance_m=3.0, max_covariance=4.0)
    recorder.process_fix(
        _make_fix(lat=-31.4858000, lon=-64.2410000),
        odom_snapshot=OdomSnapshot(x=1.0, y=2.0, yaw_deg=3.0),
    )

    ok, err, count = save_recorded_waypoints_yaml(output_file, recorder.waypoints())

    assert ok is True
    assert err == ""
    assert count == 1

    payload = yaml.safe_load(output_file.read_text(encoding="utf-8"))
    assert payload == {
        "waypoints": [
            {
                "lat": -31.4858,
                "lon": -64.241,
                "label": "wp_0",
                "x": 1.0,
                "y": 2.0,
                "yaw_deg": 3.0,
            }
        ]
    }

import math

from sensor_msgs.msg import LaserScan

from navegacion_gps.scan_wifi_debug import reduce_scan


def _make_scan() -> LaserScan:
    msg = LaserScan()
    msg.angle_min = -1.0
    msg.angle_max = 1.0
    msg.angle_increment = 0.5
    msg.time_increment = 0.01
    msg.scan_time = 0.1
    msg.range_min = 0.2
    msg.range_max = 20.0
    msg.ranges = [1.0, 2.0, 13.0, 4.0, 5.0]
    msg.intensities = [10.0, 20.0, 30.0, 40.0, 50.0]
    return msg


def test_reduce_scan_downsamples_and_clips_far_ranges() -> None:
    reduced = reduce_scan(
        _make_scan(),
        beam_stride=2,
        crop_angle_min_rad=-1.0,
        crop_angle_max_rad=1.0,
        output_range_max_m=12.0,
    )

    assert reduced is not None
    assert math.isclose(reduced.angle_min, -1.0)
    assert math.isclose(reduced.angle_max, 1.0)
    assert math.isclose(reduced.angle_increment, 1.0)
    assert math.isclose(reduced.time_increment, 0.02)
    assert reduced.ranges[0] == 1.0
    assert math.isinf(reduced.ranges[1])
    assert reduced.ranges[2] == 5.0
    assert list(reduced.intensities) == [10.0, 30.0, 50.0]


def test_reduce_scan_crops_requested_sector() -> None:
    reduced = reduce_scan(
        _make_scan(),
        beam_stride=1,
        crop_angle_min_rad=-0.2,
        crop_angle_max_rad=0.6,
        output_range_max_m=20.0,
    )

    assert reduced is not None
    assert math.isclose(reduced.angle_min, 0.0)
    assert math.isclose(reduced.angle_max, 0.5)
    assert list(reduced.ranges) == [13.0, 4.0]

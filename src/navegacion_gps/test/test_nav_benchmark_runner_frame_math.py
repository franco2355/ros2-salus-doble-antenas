import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from navegacion_gps.frame_math import transform_xy_to_map_frame  # noqa: E402


def test_transform_xy_to_map_frame_passthrough_for_map_source() -> None:
    map_xy = transform_xy_to_map_frame(
        12.5,
        -3.0,
        source_frame="map",
        map_odom_x=8.0,
        map_odom_y=2.0,
        map_odom_yaw_deg=37.0,
    )

    assert map_xy == (12.5, -3.0)


def test_transform_xy_to_map_frame_applies_map_odom_transform_for_odom_source() -> None:
    map_xy = transform_xy_to_map_frame(
        2.0,
        1.0,
        source_frame="odom",
        map_odom_x=10.0,
        map_odom_y=-4.0,
        map_odom_yaw_deg=90.0,
    )

    assert map_xy[0] == 9.0
    assert map_xy[1] == -2.0

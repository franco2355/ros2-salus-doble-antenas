import math
import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from navegacion_gps.heading_math import circular_mean_deg
from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.heading_math import shortest_angular_distance_deg
from navegacion_gps.heading_math import yaw_deg_from_quaternion_xyzw


def test_normalize_yaw_deg_wraps_positive_angles() -> None:
    assert normalize_yaw_deg(190.0) == -170.0


def test_normalize_yaw_deg_wraps_negative_angles() -> None:
    assert normalize_yaw_deg(-190.0) == 170.0


def test_shortest_angular_distance_deg_returns_signed_delta() -> None:
    assert shortest_angular_distance_deg(170.0, -170.0) == 20.0


def test_circular_mean_deg_handles_wraparound() -> None:
    mean = circular_mean_deg([179.0, -179.0, 180.0])
    assert mean is not None
    assert abs(abs(mean) - 180.0) < 1.0e-6


def test_yaw_deg_from_quaternion_xyzw_extracts_east() -> None:
    assert yaw_deg_from_quaternion_xyzw(0.0, 0.0, 0.0, 1.0) == 0.0


def test_yaw_deg_from_quaternion_xyzw_extracts_north() -> None:
    yaw_rad = math.radians(90.0)
    z = math.sin(yaw_rad / 2.0)
    w = math.cos(yaw_rad / 2.0)
    assert abs(yaw_deg_from_quaternion_xyzw(0.0, 0.0, z, w) - 90.0) < 1.0e-6

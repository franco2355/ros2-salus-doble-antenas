"""
Tests para path_cross_track_monitor.

Cero dependencias de ROS — corren con `pytest` puro.
"""
from __future__ import annotations

import math

from navegacion_gps.path_cross_track_monitor import (
    _dist_point_to_segment,
    cross_track_error,
    extract_path_xy,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _Pt:
    def __init__(self, x, y):
        self.position = type("P", (), {"x": x, "y": y, "z": 0.0})()

class _PoseStamped:
    def __init__(self, x, y):
        self.pose = _Pt(x, y)

class _FakePath:
    def __init__(self, points):
        self.poses = [_PoseStamped(x, y) for x, y in points]


# ---------------------------------------------------------------------------
# _dist_point_to_segment
# ---------------------------------------------------------------------------

def test_dist_to_segment_midpoint() -> None:
    """Punto perpendicular al centro del segmento."""
    d = _dist_point_to_segment(0.0, 1.0,  -1.0, 0.0,  1.0, 0.0)
    assert math.isclose(d, 1.0, abs_tol=1e-9)


def test_dist_to_segment_on_line() -> None:
    """Punto sobre el segmento → distancia 0."""
    d = _dist_point_to_segment(0.5, 0.0,  0.0, 0.0,  1.0, 0.0)
    assert math.isclose(d, 0.0, abs_tol=1e-9)


def test_dist_to_segment_beyond_end() -> None:
    """Punto más allá del extremo B → distancia al extremo B."""
    d = _dist_point_to_segment(2.0, 0.0,  0.0, 0.0,  1.0, 0.0)
    assert math.isclose(d, 1.0, abs_tol=1e-9)


def test_dist_to_segment_before_start() -> None:
    """Punto antes del extremo A → distancia al extremo A."""
    d = _dist_point_to_segment(-1.0, 0.0,  0.0, 0.0,  1.0, 0.0)
    assert math.isclose(d, 1.0, abs_tol=1e-9)


def test_dist_to_degenerate_segment() -> None:
    """Segmento con A==B → distancia al punto."""
    d = _dist_point_to_segment(3.0, 4.0,  0.0, 0.0,  0.0, 0.0)
    assert math.isclose(d, 5.0, abs_tol=1e-9)


def test_dist_diagonal_segment() -> None:
    """Segmento diagonal 45°, punto perpendicular desde la mitad."""
    # Segmento A=(0,0) B=(2,2), punto P=(0,2)
    # Pie perpendicular en (1,1), distancia = sqrt(2)
    d = _dist_point_to_segment(0.0, 2.0,  0.0, 0.0,  2.0, 2.0)
    assert math.isclose(d, math.sqrt(2.0), abs_tol=1e-9)


# ---------------------------------------------------------------------------
# cross_track_error
# ---------------------------------------------------------------------------

def test_cte_empty_path_returns_none() -> None:
    result = cross_track_error(1.0, 2.0, [])
    assert result is None


def test_cte_single_point() -> None:
    result = cross_track_error(3.0, 4.0, [(0.0, 0.0)])
    assert math.isclose(result, 5.0, abs_tol=1e-9)


def test_cte_robot_on_path_returns_zero() -> None:
    path = [(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]
    result = cross_track_error(3.0, 0.0, path)
    assert math.isclose(result, 0.0, abs_tol=1e-9)


def test_cte_robot_perpendicular_to_middle_segment() -> None:
    """Robot a 1 m del segmento del medio → CTE = 1 m."""
    path = [(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]
    result = cross_track_error(3.0, 1.0, path)
    assert math.isclose(result, 1.0, abs_tol=1e-9)


def test_cte_robot_far_from_path() -> None:
    """Robot a (0, 5) de un path horizontal en y=0 → CTE = 5 m."""
    path = [(0.0, 0.0), (10.0, 0.0)]
    result = cross_track_error(5.0, 5.0, path)
    assert math.isclose(result, 5.0, abs_tol=1e-9)


def test_cte_selects_closest_segment() -> None:
    """Path en L — robot cerca del codo."""
    # Path: (0,0) → (5,0) → (5,5)
    # Robot en (5.5, 2.5) — más cerca del segmento vertical
    path = [(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)]
    result = cross_track_error(5.5, 2.5, path)
    assert math.isclose(result, 0.5, abs_tol=1e-9)


def test_cte_typical_oscillation_amplitude() -> None:
    """
    Simula la oscilación reportada: robot zigzaguea ±0.3 m alrededor
    de un path recto en y=0.  El CTE debe reflejar la amplitud real.
    """
    path = [(0.0, 0.0), (20.0, 0.0)]
    # Pico de la oscilación
    cte_peak = cross_track_error(10.0, 0.30, path)
    assert math.isclose(cte_peak, 0.30, abs_tol=1e-9)

    cte_center = cross_track_error(10.0, 0.0, path)
    assert math.isclose(cte_center, 0.0, abs_tol=1e-9)


# ---------------------------------------------------------------------------
# extract_path_xy
# ---------------------------------------------------------------------------

def test_extract_path_xy_basic() -> None:
    path_msg = _FakePath([(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)])
    xy = extract_path_xy(path_msg)
    assert xy == [(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)]


def test_extract_path_xy_empty() -> None:
    path_msg = _FakePath([])
    xy = extract_path_xy(path_msg)
    assert xy == []

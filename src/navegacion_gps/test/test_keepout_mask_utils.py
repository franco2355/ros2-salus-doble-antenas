import numpy as np

from navegacion_gps.keepout_mask_utils import (
    exponential_gradient_from_core,
    rasterize_polygons_core,
)


def test_rasterize_core_fills_polygon():
    zone = {
        "id": "zone_a",
        "enabled": True,
        "polygon_xy": [
            {"x": 1.0, "y": 1.0},
            {"x": 2.0, "y": 1.0},
            {"x": 2.0, "y": 2.0},
            {"x": 1.0, "y": 2.0},
        ],
    }
    core_mask, clipped, outside = rasterize_polygons_core(
        zones_xy=[zone],
        width=50,
        height=50,
        resolution=0.1,
        origin_x=0.0,
        origin_y=0.0,
    )

    assert int(np.max(core_mask)) == 100
    assert clipped == {}
    assert outside == []


def test_rasterize_reports_outside_zone():
    outside_zone = {
        "id": "zone_out",
        "enabled": True,
        "polygon_xy": [
            {"x": 20.0, "y": 20.0},
            {"x": 21.0, "y": 20.0},
            {"x": 21.0, "y": 21.0},
        ],
    }
    core_mask, clipped, outside = rasterize_polygons_core(
        zones_xy=[outside_zone],
        width=100,
        height=100,
        resolution=0.1,
        origin_x=0.0,
        origin_y=0.0,
    )

    assert int(np.max(core_mask)) == 0
    assert clipped == {}
    assert outside == ["zone_out"]


def test_exponential_gradient_decreases_with_distance():
    core = np.zeros((81, 81), dtype=np.uint8)
    cy, cx = 40, 40
    core[cy, cx] = 100

    gradient = exponential_gradient_from_core(
        core_mask=core,
        resolution=0.1,
        radius_m=2.0,
        edge_cost=12,
        min_cost=1,
        use_l2=True,
    )

    samples = [int(gradient[cy, cx + i]) for i in range(1, 6)]
    assert all(samples[i] <= samples[i - 1] for i in range(1, len(samples)))


def test_outside_radius_is_zero():
    core = np.zeros((121, 121), dtype=np.uint8)
    cy, cx = 60, 60
    core[cy, cx] = 100

    gradient = exponential_gradient_from_core(
        core_mask=core,
        resolution=0.1,
        radius_m=1.0,
        edge_cost=12,
        min_cost=1,
        use_l2=True,
    )

    assert int(gradient[cy, cx + 15]) == 0

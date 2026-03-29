import numpy as np

from navegacion_gps.zones_geojson_utils import (
    feature_and_polygon_counts,
    iter_polygons,
    normalize_geojson_object,
    rasterize_polygons_trinary,
)


def test_normalize_geojson_autocloses_polygon_ring():
    raw = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"id": "zone_a", "enabled": True},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [-64.1025, -31.4217],
                            [-64.1020, -31.4217],
                            [-64.1020, -31.4213],
                            [-64.1025, -31.4213],
                        ]
                    ],
                },
            }
        ],
    }

    doc = normalize_geojson_object(raw)
    ring = doc["features"][0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    assert len(ring) == 5

    feature_count, polygon_count = feature_and_polygon_counts(doc)
    assert feature_count == 1
    assert polygon_count == 1


def test_normalize_geojson_rejects_invalid_latitude():
    raw = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0.0, -91.0], [1.0, -91.0], [1.0, -90.5], [0.0, -91.0]]],
        },
    }
    try:
        normalize_geojson_object(raw)
    except ValueError as exc:
        assert "latitude out of range" in str(exc)
        return
    raise AssertionError("expected ValueError for invalid latitude")


def test_normalize_geojson_supports_multipolygon_with_hole():
    raw = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"id": "multi_1", "enabled": True},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [
                            [
                                [-64.0, -31.0],
                                [-63.8, -31.0],
                                [-63.8, -30.8],
                                [-64.0, -30.8],
                                [-64.0, -31.0],
                            ],
                            [
                                [-63.95, -30.95],
                                [-63.85, -30.95],
                                [-63.85, -30.85],
                                [-63.95, -30.85],
                                [-63.95, -30.95],
                            ],
                        ],
                        [
                            [
                                [-64.2, -31.2],
                                [-64.1, -31.2],
                                [-64.1, -31.1],
                                [-64.2, -31.1],
                                [-64.2, -31.2],
                            ]
                        ],
                    ],
                },
            }
        ],
    }
    doc = normalize_geojson_object(raw)
    feature_count, polygon_count = feature_and_polygon_counts(doc)
    assert feature_count == 1
    assert polygon_count == 2
    polygons = list(iter_polygons(doc))
    assert len(polygons) == 2
    assert len(polygons[0]["holes_ll"]) == 1


def test_rasterize_polygon_with_hole():
    polygon = {
        "id": "zone_hole",
        "enabled": True,
        "outer_xy": [
            {"x": 1.0, "y": 1.0},
            {"x": 4.0, "y": 1.0},
            {"x": 4.0, "y": 4.0},
            {"x": 1.0, "y": 4.0},
            {"x": 1.0, "y": 1.0},
        ],
        "holes_xy": [
            [
                {"x": 2.0, "y": 2.0},
                {"x": 3.0, "y": 2.0},
                {"x": 3.0, "y": 3.0},
                {"x": 2.0, "y": 3.0},
                {"x": 2.0, "y": 2.0},
            ]
        ],
    }

    image, clipped, outside = rasterize_polygons_trinary(
        polygons_xy=[polygon],
        width=80,
        height=80,
        resolution=0.1,
        origin_x=0.0,
        origin_y=0.0,
        buffer_margin_m=0.0,
    )

    assert clipped == {}
    assert outside == []
    assert int(np.min(image)) == 0
    assert int(np.max(image)) == 255

    # Hole center should remain free (white)
    row = 80 - 1 - int(np.floor((2.5 - 0.0) / 0.1))
    col = int(np.floor((2.5 - 0.0) / 0.1))
    assert int(image[row, col]) == 255


def test_rasterize_buffer_expands_occupied_area():
    polygon = {
        "id": "zone_buffer",
        "enabled": True,
        "outer_xy": [
            {"x": 1.0, "y": 1.0},
            {"x": 2.0, "y": 1.0},
            {"x": 2.0, "y": 2.0},
            {"x": 1.0, "y": 2.0},
            {"x": 1.0, "y": 1.0},
        ],
        "holes_xy": [],
    }

    image_no_buffer, _, _ = rasterize_polygons_trinary(
        polygons_xy=[polygon],
        width=100,
        height=100,
        resolution=0.1,
        origin_x=0.0,
        origin_y=0.0,
        buffer_margin_m=0.0,
    )
    image_buffer, _, _ = rasterize_polygons_trinary(
        polygons_xy=[polygon],
        width=100,
        height=100,
        resolution=0.1,
        origin_x=0.0,
        origin_y=0.0,
        buffer_margin_m=0.4,
    )

    occupied_no_buffer = int(np.sum(image_no_buffer == 0))
    occupied_buffer = int(np.sum(image_buffer == 0))
    assert occupied_buffer > occupied_no_buffer

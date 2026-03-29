from navegacion_gps.nav_command_server import NavCommandServerNode


class _FakeFromLLFallbackNode:
    _ll_delta_to_north_east_m = staticmethod(NavCommandServerNode._ll_delta_to_north_east_m)
    _rotate_enu_to_map = staticmethod(NavCommandServerNode._rotate_enu_to_map)
    _approx_from_ll = NavCommandServerNode._approx_from_ll
    _should_use_approx_from_ll = NavCommandServerNode._should_use_approx_from_ll

    def __init__(self) -> None:
        self.approx_fromll_fallback_enabled = True
        self.approx_fromll_datum_lat = -31.4858037
        self.approx_fromll_datum_lon = -64.2410570
        self.approx_fromll_datum_yaw_deg = 0.0
        self.approx_fromll_zero_threshold_m = 1.0e-3
        self.approx_fromll_min_distance_for_fallback_m = 0.5


def test_approx_from_ll_returns_local_enu_when_yaw_is_zero() -> None:
    node = _FakeFromLLFallbackNode()

    converted = node._approx_from_ll(-31.485794716886354, -64.2410570)

    assert converted is not None
    x, y, z = converted
    assert abs(x) < 0.15
    assert 0.9 < y < 1.1
    assert z == 0.0


def test_should_use_fallback_for_degenerate_origin_when_goal_is_far_from_datum() -> None:
    node = _FakeFromLLFallbackNode()

    should_use = node._should_use_approx_from_ll(
        lat=-31.485794716886354,
        lon=-64.2410570,
        converted=(0.0, 0.0, 0.0),
    )

    assert should_use is True


def test_should_not_use_fallback_for_goal_effectively_at_datum() -> None:
    node = _FakeFromLLFallbackNode()

    should_use = node._should_use_approx_from_ll(
        lat=node.approx_fromll_datum_lat,
        lon=node.approx_fromll_datum_lon,
        converted=(0.0, 0.0, 0.0),
    )

    assert should_use is False

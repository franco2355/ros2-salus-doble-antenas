from pathlib import Path

import yaml


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def test_navigation_profiles_yaml_defines_local_and_global_defaults() -> None:
    config_path = PACKAGE_ROOT / "config" / "navigation_profiles.yaml"
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    profiles = raw.get("profiles", {})

    assert profiles["local_v2"]["map_frame"] == "odom"
    assert profiles["local_v2"]["fromll_frame"] == "odom"
    assert profiles["local_v2"]["keepout_mask_frame"] == "odom"
    assert profiles["local_v2"]["odom_topic"] == "/odometry/local"

    assert profiles["global_v2"]["map_frame"] == "map"
    assert profiles["global_v2"]["fromll_frame"] == "map"
    assert profiles["global_v2"]["keepout_mask_frame"] == "map"
    assert profiles["global_v2"]["odom_topic"] == "/odometry/global"
    assert profiles["global_v2"]["navsat_use_odometry_yaw"] is True
    assert profiles["global_v2"]["datum_lat"] == -31.4858037
    assert profiles["global_v2"]["datum_lon"] == -64.2410570
    assert profiles["global_v2"]["datum_yaw_deg"] == 0.0

from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LAUNCH_DIR = PACKAGE_ROOT / "launch"


def _read_launch_file(name: str) -> str:
    return (LAUNCH_DIR / name).read_text(encoding="utf-8")


def test_simulation_realism_mode_reuses_nav2_only_launch() -> None:
    simulation_launch = _read_launch_file("simulacion.launch.py")

    assert '"realism_mode"' in simulation_launch
    assert 'default_value="True"' in simulation_launch
    assert '"gps_profile"' in simulation_launch
    assert "nav2_only.launch.py" in simulation_launch
    assert "collision_monitor_lidar_only.yaml" in simulation_launch
    assert "else ('m8n'" in simulation_launch


def test_real_and_simulation_share_navigation_contracts() -> None:
    simulation_launch = _read_launch_file("simulacion.launch.py")
    real_launch = _read_launch_file("real.launch.py")

    assert "dual_ekf_navsat_params.yaml" in simulation_launch
    assert "dual_ekf_navsat_params.yaml" in real_launch
    assert 'default_value="/gps/fix"' in simulation_launch
    assert 'default_value="/gps/fix"' in real_launch
    assert '"odometry/local"' in simulation_launch
    assert '"odometry/local"' in real_launch
    assert '"/gps/rtk_status"' in simulation_launch


def test_simulation_launch_exposes_localization_profiles() -> None:
    simulation_launch = _read_launch_file("simulacion.launch.py")

    assert '"sim_localization_profile"' in simulation_launch
    assert '"sim_localization_params_file"' in simulation_launch
    assert "dual_ekf_navsat_params.sim_navsat_imu_heading.yaml" in simulation_launch
    assert "dual_ekf_navsat_params.sim_decouple_global_yaw.yaml" in simulation_launch
    assert "dual_ekf_navsat_params.sim_decouple_global_twist_only.yaml" in simulation_launch
    assert (
        "dual_ekf_navsat_params.sim_decouple_global_linear_twist_only.yaml"
        in simulation_launch
    )
    assert "dual_ekf_navsat_params.sim_gps_only_global.yaml" not in simulation_launch

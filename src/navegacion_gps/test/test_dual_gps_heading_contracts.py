from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (PACKAGE_ROOT / relative_path).read_text(encoding="utf-8")


def test_real_launch_supports_dual_gps_heading_modes() -> None:
    launch_contents = _read("launch/real.launch.py")

    assert 'DeclareLaunchArgument(\n        "use_dual_gps_heading",' in launch_contents
    assert 'DeclareLaunchArgument(\n        "ublox_device",' in launch_contents
    assert 'DeclareLaunchArgument(\n        "ublox_params_file",' in launch_contents
    assert "dual_gps_heading_ekf_overlay.yaml" in launch_contents
    assert "dual_gps_heading_hw.launch.py" in launch_contents
    assert "use_dual_gps_heading must be one of " in launch_contents
    assert "Usa `use_dual_gps_heading:=auto` para fallback automatico" in launch_contents


def test_dual_gps_heading_launch_uses_ublox_navheading() -> None:
    launch_contents = _read("launch/dual_gps_heading_hw.launch.py")

    assert 'package="ublox_gps"' in launch_contents
    assert 'executable="ublox_gps_node"' in launch_contents
    assert 'default_value="/ublox_rover/navheading"' in launch_contents
    assert 'default_value="/dual_gps/heading"' in launch_contents
    assert 'default_value="base_link"' in launch_contents
    assert 'default_value="0.0"' in launch_contents
    assert "front/rear baseline" in launch_contents


def test_dual_gps_heading_entrypoint_and_dependency_are_registered() -> None:
    setup_contents = _read("setup.py")
    package_contents = _read("package.xml")

    assert "'dual_gps_heading_real = navegacion_gps.dual_gps_heading_real:main'" in setup_contents
    assert "<exec_depend>ublox_gps</exec_depend>" in package_contents


def test_dual_gps_heading_sim_publishes_body_relative_yaw() -> None:
    sim_contents = _read("navegacion_gps/dual_gps_heading_sim.py")

    assert "raw_heading_rad = _normalize_angle(self._raw_yaw_offset_rad)" in sim_contents
    assert "not the absolute world yaw from `/odom_raw`" in sim_contents


def test_dual_gps_heading_overlay_supports_local_v2_ekf() -> None:
    overlay_contents = _read("config/dual_gps_heading_ekf_overlay.yaml")

    assert "ekf_filter_node_odom:" in overlay_contents
    assert "ekf_filter_node_local_v2:" in overlay_contents
    assert "imu1: /dual_gps/heading" in overlay_contents


def test_cuatri_real_urdf_keeps_dual_gps_frames() -> None:
    urdf_contents = _read("models/cuatri_real.urdf")

    assert '<link name="gps1_link">' in urdf_contents
    assert '<link name="gps2_link">' in urdf_contents
    assert "Front antenna" in urdf_contents
    assert "Rear antenna" in urdf_contents


def test_cuatri_2gps_urdf_keeps_second_simulated_gps_sensor() -> None:
    urdf_contents = _read("models/cuatri_2gps.urdf")

    assert '<link name="gps_link2">' in urdf_contents
    assert '<gazebo reference="gps_link2">' in urdf_contents
    assert "<topic>/gps2/fix</topic>" in urdf_contents


def test_navheading_pose_bridge_preserves_input_frame_id() -> None:
    bridge_contents = _read("navegacion_gps/navheading_pose_bridge.py")

    # Must import tf2_ros for the TF lookup
    assert "import tf2_ros" in bridge_contents

    # Keep output_frame as fallback, but prefer the incoming IMU frame_id
    assert 'self.declare_parameter("output_frame", "map")' in bridge_contents
    assert 'out.header.frame_id = str(msg.header.frame_id) or self._output_frame' in bridge_contents

    # Must have a robot_frame parameter to know which frame to look up
    assert 'self.declare_parameter("robot_frame"' in bridge_contents

    # The lookup target must match the published frame to keep pose coordinates coherent
    assert "out.header.frame_id," in bridge_contents


def test_rviz_launches_do_not_override_navheading_output_frame_to_base_link() -> None:
    """Regression: neither rviz launch may force output_frame='base_link'.

    If a launch explicitly sets output_frame to base_link it re-introduces
    the double-rotation bug even after the bridge default was fixed.
    """
    for launch_file in (
        "launch/rviz_sim_global_v2.launch.py",
        "launch/rviz_real_global_v2.launch.py",
    ):
        contents = _read(launch_file)
        # The value "base_link" must not appear as the output_frame argument
        assert '"output_frame": "base_link"' not in contents
        assert '"output_frame": \'base_link\'' not in contents

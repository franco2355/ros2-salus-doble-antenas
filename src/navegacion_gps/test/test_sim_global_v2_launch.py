from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (PACKAGE_ROOT / relative_path).read_text(encoding="utf-8")


def test_sim_global_v2_launch_reuses_current_sim_stack_without_rviz() -> None:
    launch_contents = _read("launch/sim_global_v2.launch.py")

    assert "sim_v2_base.launch.py" in launch_contents
    assert "localization_global_v2.launch.py" in launch_contents
    assert "nav_global_v2.launch.py" in launch_contents
    assert "no_go_editor.launch.py" in launch_contents
    assert '"fromll_frame": "map"' in launch_contents
    assert '"map_frame": "map"' in launch_contents
    assert '"approx_fromll_fallback_enabled": True' in launch_contents
    assert 'DeclareLaunchArgument("datum_lat", default_value="-31.4858037")' in launch_contents
    assert 'DeclareLaunchArgument("datum_lon", default_value="-64.2410570")' in launch_contents
    assert 'DeclareLaunchArgument("datum_yaw_deg", default_value="0.0")' in launch_contents
    assert 'DeclareLaunchArgument("enable_map_gps_absolute_measurement", default_value="true")' in launch_contents
    assert 'DeclareLaunchArgument("map_gps_absolute_topic", default_value="/gps/odometry_map")' in launch_contents
    assert 'DeclareLaunchArgument("map_gps_pose_covariance_xy", default_value="0.05")' in launch_contents
    assert 'DeclareLaunchArgument("map_gps_fromll_service", default_value="/fromLL")' in launch_contents
    assert 'DeclareLaunchArgument(' in launch_contents
    assert '"enable_map_gps_absolute_measurement": enable_map_gps_absolute_measurement' in launch_contents
    assert '"map_gps_absolute_topic": map_gps_absolute_topic' in launch_contents
    assert '"map_gps_fromll_service_fallback": map_gps_fromll_service_fallback' in launch_contents
    assert 'DeclareLaunchArgument("enable_gps_course_heading", default_value="true")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_min_distance_m", default_value="1.0")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_min_speed_mps", default_value="0.4")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_max_abs_steer_deg", default_value="3.0")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_max_abs_yaw_rate_rps", default_value="0.06")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_publish_hz", default_value="10.0")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_yaw_variance_rad2", default_value="0.05")' in launch_contents
    assert 'DeclareLaunchArgument("gps_profile", default_value="ideal")' in launch_contents
    assert 'executable="gps_course_heading"' in launch_contents
    assert '"gps_profile": gps_profile' in launch_contents
    assert '"approx_fromll_datum_lat": ParameterValue(datum_lat, value_type=float)' in launch_contents
    assert '"approx_fromll_datum_lon": ParameterValue(datum_lon, value_type=float)' in launch_contents
    assert '"approx_fromll_datum_yaw_deg": ParameterValue(' in launch_contents
    assert '"navsat_use_odometry_yaw": "false"' in launch_contents
    assert '"enable_gps_course_heading": enable_gps_course_heading' in launch_contents
    assert '"gps_course_heading_topic": "/gps/course_heading"' in launch_contents
    assert '"publish_hz": ParameterValue(' in launch_contents
    assert 'DeclareLaunchArgument("launch_web_app", default_value="True")' in launch_contents
    assert '"odom_topic": "/odometry/global"' in launch_contents
    assert '"launch_nav_command_server": "false"' in launch_contents
    assert 'executable="rviz2"' not in launch_contents


def test_localization_global_v2_launch_adds_map_filter_and_navsat_support() -> None:
    launch_contents = _read("launch/localization_global_v2.launch.py")

    assert "localization_v2.launch.py" in launch_contents
    assert 'name="global_odom_stationary_gate"' in launch_contents
    assert 'name="global_imu_stationary_gate"' in launch_contents
    assert 'name="global_yaw_stationary_hold"' in launch_contents
    assert 'name="map_gps_absolute_measurement"' in launch_contents
    assert 'name="ekf_filter_node_map"' in launch_contents
    assert 'name="navsat_transform"' in launch_contents
    assert 'DeclareLaunchArgument("datum_setter", default_value="false")' in launch_contents
    assert 'DeclareLaunchArgument("navsat_use_odometry_yaw", default_value="false")' in launch_contents
    assert 'DeclareLaunchArgument(\n                "enable_global_odom_stationary_gate"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "global_odom_gated_topic"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "enable_global_imu_stationary_gate"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "global_imu_gated_topic"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "enable_global_stationary_yaw_hold"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "global_stationary_yaw_hold_topic"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "enable_map_gps_absolute_measurement"' in launch_contents
    assert 'DeclareLaunchArgument(\n                "map_gps_absolute_topic"' in launch_contents
    assert 'DeclareLaunchArgument("enable_gps_course_heading", default_value="false")' in launch_contents
    assert 'DeclareLaunchArgument("gps_course_heading_topic", default_value="/gps/course_heading")' in launch_contents
    assert '"use_odometry_yaw": navsat_use_odometry_yaw' in launch_contents
    assert '"input_odom_topic": "/odometry/local"' in launch_contents
    assert '"output_odom_topic": global_odom_gated_topic' in launch_contents
    assert '"drive_telemetry_topic": drive_telemetry_topic' in launch_contents
    assert '{"odom0": map_filter_odom_topic}' in launch_contents
    assert '"input_imu_topic": imu_topic' in launch_contents
    assert '"output_imu_topic": global_imu_gated_topic' in launch_contents
    assert '{"imu0": map_filter_imu_topic}' in launch_contents
    assert '"output_odom_topic": global_stationary_yaw_hold_topic' in launch_contents
    assert '"odom2": global_stationary_yaw_hold_topic' in launch_contents
    assert '"odom2_config": [' in launch_contents
    assert '"output_topic": map_gps_absolute_topic' in launch_contents
    assert '"fromll_service": map_gps_fromll_service' in launch_contents
    assert '{"odom1": map_gps_absolute_topic}' in launch_contents
    assert '"imu1": gps_course_heading_topic' in launch_contents
    assert '"imu1_config": [' in launch_contents
    assert '("odometry/filtered", "/odometry/local")' in launch_contents
    assert '("odometry/gps", "/odometry/gps")' in launch_contents


def test_nav2_global_params_switch_global_frame_to_map() -> None:
    params_contents = _read("config/nav2_global_v2_params.yaml")

    assert "global_frame: map" in params_contents
    assert "local_frame: odom" in params_contents
    assert "odom_topic: /odometry/local" in params_contents


def test_rviz_global_config_and_launch_target_map() -> None:
    rviz_contents = _read("config/rviz_global_v2.rviz")
    launch_contents = _read("launch/rviz_sim_global_v2.launch.py")

    assert "Fixed Frame: map" in rviz_contents
    assert "/odometry/global" in rviz_contents
    assert "/gps/odometry_map" in rviz_contents
    assert "GPS Map Odom" in rviz_contents
    assert "rviz_global_v2.rviz" in launch_contents

from pathlib import Path


def test_sim_local_v2_launch_uses_realistic_command_chain() -> None:
    launch_path = (
        Path(__file__).resolve().parents[1] / "launch" / "sim_local_v2.launch.py"
    )
    launch_contents = launch_path.read_text(encoding="utf-8")

    assert 'executable="nav_command_server"' in launch_contents
    assert 'package="controller_server"' in launch_contents
    assert '"transport_backend": "sim_gazebo"' in launch_contents
    assert '"cmd_vel_final_topic": "/cmd_vel_final"' in launch_contents
    assert '"forward_cmd_vel_safe_without_goal": True' in launch_contents
    assert 'DeclareLaunchArgument("gps_profile", default_value="ideal")' in launch_contents
    assert '"gps_profile": gps_profile' in launch_contents


def test_sim_local_v2_launch_disables_legacy_bridge_nodes() -> None:
    launch_path = (
        Path(__file__).resolve().parents[1] / "launch" / "sim_local_v2.launch.py"
    )
    launch_contents = launch_path.read_text(encoding="utf-8")

    assert 'executable="cmd_vel_ackermann_bridge_v2"' not in launch_contents
    assert 'executable="sim_drive_telemetry"' not in launch_contents
    assert 'DeclareLaunchArgument("invert_measured_steer_sign", default_value="True")' in launch_contents
    assert 'DeclareLaunchArgument("invert_steer_from_cmd_vel", default_value="True")' in launch_contents

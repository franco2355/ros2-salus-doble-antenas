from __future__ import annotations

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description() -> LaunchDescription:
    package_share = get_package_share_directory("navegacion_gps")
    waypoints_file = LaunchConfiguration("waypoints_file")
    min_distance_m = LaunchConfiguration("min_distance_m")
    nav_mode = LaunchConfiguration("nav_mode")
    loop_delay_s = LaunchConfiguration("loop_delay_s")

    return LaunchDescription(
        [
            DeclareLaunchArgument(
                "waypoints_file",
                default_value="~/.ros/recorded_waypoints.yaml",
            ),
            DeclareLaunchArgument("min_distance_m", default_value="3.0"),
            DeclareLaunchArgument("nav_mode", default_value="global"),
            DeclareLaunchArgument("loop_delay_s", default_value="1.0"),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    f"{package_share}/launch/real_global_v2.launch.py"
                )
            ),
            Node(
                package="navegacion_gps",
                executable="manual_waypoint_recorder",
                name="manual_waypoint_recorder",
                output="screen",
                parameters=[
                    {
                        "min_distance_m": min_distance_m,
                        "output_file": waypoints_file,
                    }
                ],
            ),
            Node(
                package="navegacion_gps",
                executable="loop_patrol_runner",
                name="loop_patrol_runner",
                output="screen",
                parameters=[
                    {
                        "waypoints_file": waypoints_file,
                        "nav_mode": nav_mode,
                        "loop_delay_s": loop_delay_s,
                    }
                ],
            ),
        ]
    )

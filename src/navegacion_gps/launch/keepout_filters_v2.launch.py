from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def _resolve_config_file_path(package_share_dir: str, filename: str) -> str:
    package_share_path = Path(package_share_dir)
    default_path = package_share_path / "config" / filename
    try:
        workspace_root = package_share_path.parents[3]
        source_path = workspace_root / "src" / "navegacion_gps" / "config" / filename
        if source_path.parent.exists():
            return str(source_path)
    except IndexError:
        pass
    return str(default_path)


def generate_launch_description():
    gps_wpf_dir = get_package_share_directory("navegacion_gps")
    default_keepout_mask = _resolve_config_file_path(gps_wpf_dir, "keepout_mask.yaml")

    use_sim_time = LaunchConfiguration("use_sim_time")
    keepout_mask_yaml = LaunchConfiguration("keepout_mask_yaml")
    keepout_mask_frame = LaunchConfiguration("keepout_mask_frame")

    return LaunchDescription(
        [
            DeclareLaunchArgument("use_sim_time", default_value="False"),
            DeclareLaunchArgument("keepout_mask_yaml", default_value=default_keepout_mask),
            DeclareLaunchArgument("keepout_mask_frame", default_value="odom"),
            Node(
                package="nav2_map_server",
                executable="map_server",
                name="keepout_filter_mask_server",
                output="screen",
                parameters=[
                    {
                        "yaml_filename": keepout_mask_yaml,
                        "topic_name": "/keepout_filter_mask",
                        "frame_id": keepout_mask_frame,
                    },
                    {"use_sim_time": ParameterValue(use_sim_time, value_type=bool)},
                ],
            ),
            Node(
                package="nav2_map_server",
                executable="costmap_filter_info_server",
                name="keepout_costmap_filter_info_server",
                output="screen",
                parameters=[
                    {
                        "type": 0,
                        "filter_info_topic": "/costmap_filter_info",
                        "mask_topic": "/keepout_filter_mask",
                        "base": 0.0,
                        "multiplier": 1.0,
                    },
                    {"use_sim_time": ParameterValue(use_sim_time, value_type=bool)},
                ],
            ),
            Node(
                package="nav2_lifecycle_manager",
                executable="lifecycle_manager",
                name="lifecycle_manager_keepout_filters",
                output="screen",
                parameters=[
                    {
                        "use_sim_time": ParameterValue(use_sim_time, value_type=bool),
                        "autostart": True,
                        "bond_timeout": 4.0,
                        "node_names": [
                            "keepout_filter_mask_server",
                            "keepout_costmap_filter_info_server",
                        ],
                    }
                ],
            ),
        ]
    )

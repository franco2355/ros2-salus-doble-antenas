import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    navegacion_gps_share_dir = get_package_share_directory("navegacion_gps")
    cyclonedds_config_path = os.path.join(
        navegacion_gps_share_dir,
        "config",
        "cyclonedds_wifi.xml",
    )

    ws_host = LaunchConfiguration("ws_host")
    ws_port = LaunchConfiguration("ws_port")
    gps_topic = LaunchConfiguration("gps_topic")
    gps_status_topic = LaunchConfiguration("gps_status_topic")
    odom_topic = LaunchConfiguration("odom_topic")
    map_frame = LaunchConfiguration("map_frame")
    launch_zones_manager = LaunchConfiguration("launch_zones_manager")
    launch_nav_command_server = LaunchConfiguration("launch_nav_command_server")
    launch_nav_snapshot_server = LaunchConfiguration("launch_nav_snapshot_server")

    zones_set_geojson_service = LaunchConfiguration("zones_set_geojson_service")
    zones_get_state_service = LaunchConfiguration("zones_get_state_service")
    zones_reload_service = LaunchConfiguration("zones_reload_service")

    nav_set_goal_service = LaunchConfiguration("nav_set_goal_service")
    nav_cancel_goal_service = LaunchConfiguration("nav_cancel_goal_service")
    nav_brake_service = LaunchConfiguration("nav_brake_service")
    nav_set_manual_mode_service = LaunchConfiguration("nav_set_manual_mode_service")
    nav_get_state_service = LaunchConfiguration("nav_get_state_service")
    teleop_cmd_topic = LaunchConfiguration("teleop_cmd_topic")

    nav_snapshot_service = LaunchConfiguration("nav_snapshot_service")
    nav_telemetry_topic = LaunchConfiguration("nav_telemetry_topic")
    camera_pan_service = LaunchConfiguration("camera_pan_service")
    camera_status_service = LaunchConfiguration("camera_status_service")

    request_timeout_s = LaunchConfiguration("request_timeout_s")
    snapshot_request_timeout_s = LaunchConfiguration("snapshot_request_timeout_s")
    set_zones_timeout_s = LaunchConfiguration("set_zones_timeout_s")
    set_goal_timeout_s = LaunchConfiguration("set_goal_timeout_s")
    datum_lat = LaunchConfiguration("datum_lat")
    datum_lon = LaunchConfiguration("datum_lon")
    datum_yaw_deg = LaunchConfiguration("datum_yaw_deg")
    rtk_source_status_topic = LaunchConfiguration("rtk_source_status_topic")
    launch_waypoint_recorder = LaunchConfiguration("launch_waypoint_recorder")
    waypoint_recorder_output_file = LaunchConfiguration("waypoint_recorder_output_file")
    waypoint_recorder_min_distance_m = LaunchConfiguration("waypoint_recorder_min_distance_m")

    return LaunchDescription(
        [
            DeclareLaunchArgument("ws_host", default_value="0.0.0.0"),
            DeclareLaunchArgument("ws_port", default_value="8766"),
            DeclareLaunchArgument("gps_topic", default_value="/gps/fix"),
            DeclareLaunchArgument("gps_status_topic", default_value="/gps/rtk_status"),
            DeclareLaunchArgument("odom_topic", default_value="/odometry/local"),
            DeclareLaunchArgument("map_frame", default_value="map"),
            DeclareLaunchArgument("launch_zones_manager", default_value="true"),
            DeclareLaunchArgument("launch_nav_command_server", default_value="true"),
            DeclareLaunchArgument("launch_nav_snapshot_server", default_value="true"),
            DeclareLaunchArgument(
                "zones_set_geojson_service", default_value="/zones_manager/set_geojson"
            ),
            DeclareLaunchArgument(
                "zones_get_state_service", default_value="/zones_manager/get_state"
            ),
            DeclareLaunchArgument(
                "zones_reload_service", default_value="/zones_manager/reload_from_disk"
            ),
            DeclareLaunchArgument(
                "nav_set_goal_service", default_value="/nav_command_server/set_goal_ll"
            ),
            DeclareLaunchArgument(
                "nav_cancel_goal_service", default_value="/nav_command_server/cancel_goal"
            ),
            DeclareLaunchArgument(
                "nav_brake_service", default_value="/nav_command_server/brake"
            ),
            DeclareLaunchArgument(
                "nav_set_manual_mode_service",
                default_value="/nav_command_server/set_manual_mode",
            ),
            DeclareLaunchArgument(
                "teleop_cmd_topic",
                default_value="/cmd_vel_teleop",
            ),
            DeclareLaunchArgument(
                "nav_get_state_service", default_value="/nav_command_server/get_state"
            ),
            DeclareLaunchArgument(
                "nav_snapshot_service",
                default_value="/nav_snapshot_server/get_nav_snapshot",
            ),
            DeclareLaunchArgument(
                "nav_telemetry_topic",
                default_value="/nav_command_server/telemetry",
            ),
            DeclareLaunchArgument(
                "camera_pan_service",
                default_value="/camara/camera_pan",
            ),
            DeclareLaunchArgument(
                "camera_status_service",
                default_value="/camara/camera_status",
            ),
            DeclareLaunchArgument("request_timeout_s", default_value="5.0"),
            DeclareLaunchArgument("snapshot_request_timeout_s", default_value="2.0"),
            DeclareLaunchArgument("set_zones_timeout_s", default_value="12.0"),
            DeclareLaunchArgument("set_goal_timeout_s", default_value="12.0"),
            DeclareLaunchArgument("datum_lat", default_value="nan"),
            DeclareLaunchArgument("datum_lon", default_value="nan"),
            DeclareLaunchArgument("datum_yaw_deg", default_value="0.0"),
            DeclareLaunchArgument("rtk_source_status_topic", default_value="/gps/rtk_source/status_json"),
            DeclareLaunchArgument("launch_waypoint_recorder", default_value="true"),
            DeclareLaunchArgument(
                "waypoint_recorder_output_file",
                default_value="~/.ros/recorded_waypoints.yaml",
            ),
            DeclareLaunchArgument("waypoint_recorder_min_distance_m", default_value="3.0"),
            Node(
                package="navegacion_gps",
                executable="zones_manager",
                name="zones_manager",
                output="screen",
                condition=IfCondition(launch_zones_manager),
                parameters=[
                    {
                        "map_frame": map_frame,
                        "set_geojson_service": zones_set_geojson_service,
                        "get_state_service": zones_get_state_service,
                        "reload_from_disk_service": zones_reload_service,
                    }
                ],
            ),
            Node(
                package="navegacion_gps",
                executable="nav_command_server",
                name="nav_command_server",
                output="screen",
                condition=IfCondition(launch_nav_command_server),
                parameters=[
                    {
                        "map_frame": map_frame,
                        "gps_topic": gps_topic,
                        "telemetry_topic": nav_telemetry_topic,
                        "teleop_cmd_topic": teleop_cmd_topic,
                        "set_goal_service": nav_set_goal_service,
                        "cancel_goal_service": nav_cancel_goal_service,
                        "brake_service": nav_brake_service,
                        "set_manual_mode_service": nav_set_manual_mode_service,
                        "get_state_service": nav_get_state_service,
                    }
                ],
            ),
            Node(
                package="navegacion_gps",
                executable="nav_snapshot_server",
                name="nav_snapshot_server",
                output="screen",
                condition=IfCondition(launch_nav_snapshot_server),
                parameters=[
                    {
                        "get_snapshot_service": nav_snapshot_service,
                    }
                ],
            ),
            Node(
                package="map_tools",
                executable="web_zone_server",
                name="web_zone_server",
                output="screen",
                additional_env={
                    "CYCLONEDDS_URI": cyclonedds_config_path,
                    "ROS_LOCALHOST_ONLY": "0",
                    "ROS_DOMAIN_ID": "0",
                },
                parameters=[
                    {
                        "ws_host": ws_host,
                        "ws_port": ws_port,
                        "gps_topic": gps_topic,
                        "gps_status_topic": gps_status_topic,
                        "odom_topic": odom_topic,
                        "map_frame": map_frame,
                        "zones_set_geojson_service": zones_set_geojson_service,
                        "zones_get_state_service": zones_get_state_service,
                        "zones_reload_service": zones_reload_service,
                        "nav_set_goal_service": nav_set_goal_service,
                        "nav_cancel_goal_service": nav_cancel_goal_service,
                        "nav_brake_service": nav_brake_service,
                        "nav_set_manual_mode_service": nav_set_manual_mode_service,
                        "nav_get_state_service": nav_get_state_service,
                        "teleop_cmd_topic": teleop_cmd_topic,
                        "nav_snapshot_service": nav_snapshot_service,
                        "nav_telemetry_topic": nav_telemetry_topic,
                        "camera_pan_service": camera_pan_service,
                        "camera_status_service": camera_status_service,
                        "request_timeout_s": request_timeout_s,
                        "snapshot_request_timeout_s": snapshot_request_timeout_s,
                        "set_zones_timeout_s": set_zones_timeout_s,
                        "set_goal_timeout_s": set_goal_timeout_s,
                        "datum_lat": datum_lat,
                        "datum_lon": datum_lon,
                        "datum_yaw_deg": datum_yaw_deg,
                        "rtk_source_status_topic": rtk_source_status_topic,
                    }
                ],
            ),
            Node(
                package="navegacion_gps",
                executable="manual_waypoint_recorder",
                name="manual_waypoint_recorder",
                output="screen",
                condition=IfCondition(launch_waypoint_recorder),
                parameters=[
                    {
                        "gps_topic": gps_topic,
                        "output_file": waypoint_recorder_output_file,
                        "min_distance_m": waypoint_recorder_min_distance_m,
                    }
                ],
            ),
        ]
    )

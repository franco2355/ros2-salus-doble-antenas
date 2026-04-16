import math
import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    IncludeLaunchDescription,
    LogInfo,
    OpaqueFunction,
)
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
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


def _validate_telemetry_backend(context):
    telemetry_backend = LaunchConfiguration("telemetry_backend").perform(context)
    valid_backends = {"mavros", "pixhawk_driver"}
    if telemetry_backend not in valid_backends:
        raise RuntimeError(
            "telemetry_backend must be one of "
            f"{sorted(valid_backends)}, got {telemetry_backend!r}"
        )
    return []


def _as_bool(value: str) -> bool:
    return str(value).strip().lower() == "true"


def _normalize_dual_gps_mode(value: str) -> str:
    normalized = str(value).strip().lower()
    aliases = {
        "": "auto",
        "1": "true",
        "0": "false",
        "yes": "true",
        "no": "false",
        "on": "true",
        "off": "false",
        "auto": "auto",
        "true": "true",
        "false": "false",
    }
    if normalized not in aliases:
        raise RuntimeError(
            "use_dual_gps_heading must be one of "
            "auto|true|false (tambien acepta yes/no, on/off, 1/0), "
            f"got {value!r}"
        )
    return aliases[normalized]


def _resolve_real_dual_gps_heading_enabled(context) -> bool:
    requested_mode = _normalize_dual_gps_mode(
        LaunchConfiguration("use_dual_gps_heading").perform(context)
    )
    if requested_mode != "auto":
        return requested_mode == "true"

    ublox_device = LaunchConfiguration("ublox_device").perform(context).strip()
    return bool(ublox_device) and Path(ublox_device).exists()


def _build_ekf_nodes(context):
    gps_wpf_dir = get_package_share_directory("navegacion_gps")
    rl_params_file = _resolve_config_file_path(gps_wpf_dir, "dual_ekf_navsat_params.yaml")
    overlay_params_file = _resolve_config_file_path(
        gps_wpf_dir, "dual_gps_heading_ekf_overlay.yaml"
    )

    use_sim_time = _as_bool(LaunchConfiguration("use_sim_time").perform(context))
    use_navsat = _as_bool(LaunchConfiguration("use_navsat").perform(context))
    use_dual = _resolve_real_dual_gps_heading_enabled(context)

    ekf_param_files = [rl_params_file]
    if use_dual:
        ekf_param_files.append(overlay_params_file)

    nodes = [
        Node(
            package="robot_localization",
            executable="ekf_node",
            name="ekf_filter_node_odom",
            output="screen",
            parameters=ekf_param_files + [{"use_sim_time": use_sim_time}],
            remappings=[("odometry/filtered", "odometry/local")],
        ),
        Node(
            package="robot_localization",
            executable="ekf_node",
            name="ekf_filter_node_map",
            output="screen",
            parameters=ekf_param_files + [{"use_sim_time": use_sim_time}],
        ),
    ]

    if use_navsat:
        nodes.append(
            Node(
                package="robot_localization",
                executable="navsat_transform_node",
                name="navsat_transform",
                output="screen",
                parameters=ekf_param_files + [{"use_sim_time": use_sim_time}],
                remappings=[
                    ("gps/filtered", "gps/filtered"),
                    ("odometry/gps", "odometry/gps"),
                    ("odometry/filtered", "odometry/local"),
                ],
            )
        )

    return nodes


def _build_dual_gps_heading_actions(context):
    gps_wpf_dir = get_package_share_directory("navegacion_gps")
    ublox_device = LaunchConfiguration("ublox_device").perform(context).strip()
    requested_mode = _normalize_dual_gps_mode(
        LaunchConfiguration("use_dual_gps_heading").perform(context)
    )
    has_ublox_device = bool(ublox_device) and Path(ublox_device).exists()
    use_dual = _resolve_real_dual_gps_heading_enabled(context)

    if requested_mode == "auto":
        mode_label = "dual" if use_dual else "single"
        msg = (
            "[navegacion_gps] real.launch dual GPS auto -> "
            f"{mode_label} mode "
            f"(ublox_device={ublox_device or '<empty>'}, exists={has_ublox_device})"
        )
    else:
        msg = (
            "[navegacion_gps] real.launch dual GPS forced -> "
            f"{requested_mode} "
            f"(ublox_device={ublox_device or '<empty>'}, exists={has_ublox_device})"
        )

    actions = [LogInfo(msg=msg)]

    if use_dual:
        actions.append(
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    os.path.join(gps_wpf_dir, "launch", "dual_gps_heading_hw.launch.py")
                ),
                launch_arguments={
                    "use_sim_time": LaunchConfiguration("use_sim_time"),
                    "ublox_device": LaunchConfiguration("ublox_device"),
                    "ublox_params_file": LaunchConfiguration("ublox_params_file"),
                    "output_topic": LaunchConfiguration("dual_gps_heading_output_topic"),
                    "yaw_offset_rad": LaunchConfiguration("dual_gps_heading_yaw_offset_rad"),
                    "output_frame": LaunchConfiguration("dual_gps_heading_output_frame"),
                }.items(),
            )
        )

    return actions


def _validate_real_dual_gps_configuration(context):
    requested_mode = _normalize_dual_gps_mode(
        LaunchConfiguration("use_dual_gps_heading").perform(context)
    )
    ublox_device = LaunchConfiguration("ublox_device").perform(context).strip()
    has_ublox_device = bool(ublox_device) and Path(ublox_device).exists()

    if (requested_mode == "true") and (not has_ublox_device):
        raise RuntimeError(
            "Invalid real navigation configuration: use_dual_gps_heading:=true "
            f"pero ublox_device={ublox_device!r} no existe. "
            "Usa `use_dual_gps_heading:=auto` para fallback automatico o conecta el segundo GPS."
        )
    return []


def generate_launch_description():
    gps_wpf_dir = get_package_share_directory("navegacion_gps")
    map_tools_dir = get_package_share_directory("map_tools")
    sensores_dir = get_package_share_directory("sensores")

    zones_geojson_path = _resolve_config_file_path(gps_wpf_dir, "no_go_zones.geojson")
    keepout_mask_image_path = _resolve_config_file_path(gps_wpf_dir, "keepout_mask.pgm")
    keepout_mask_yaml_path = _resolve_config_file_path(gps_wpf_dir, "keepout_mask.yaml")
    lidar_to_scan_params = _resolve_config_file_path(
        gps_wpf_dir, "pointcloud_to_laserscan.yaml"
    )
    rviz_default = _resolve_config_file_path(gps_wpf_dir, "rviz_nav2_full.rviz")
    lidar_default_config = os.path.join(sensores_dir, "config", "rs16.yaml")

    use_sim_time = LaunchConfiguration("use_sim_time")
    use_robot_state_publisher = LaunchConfiguration("use_robot_state_publisher")
    custom_urdf = LaunchConfiguration("custom_urdf")
    use_rviz = LaunchConfiguration("use_rviz")
    rviz_config = LaunchConfiguration("rviz_config")
    use_mapviz = LaunchConfiguration("use_mapviz")
    use_collision_monitor = LaunchConfiguration("use_collision_monitor")
    use_gazebo_utils = LaunchConfiguration("use_gazebo_utils")
    use_pointcloud_to_laserscan = LaunchConfiguration("use_pointcloud_to_laserscan")
    telemetry_backend = LaunchConfiguration("telemetry_backend")
    start_lidar = LaunchConfiguration("start_lidar")
    launch_web = LaunchConfiguration("launch_web")
    lidar_config_path = LaunchConfiguration("lidar_config_path")
    ws_host = LaunchConfiguration("ws_host")
    ws_port = LaunchConfiguration("ws_port")
    gps_topic = LaunchConfiguration("gps_topic")
    map_frame = LaunchConfiguration("map_frame")

    declare_use_sim_time_cmd = DeclareLaunchArgument(
        "use_sim_time",
        default_value="False",
        description="Use simulation clock if true",
    )
    declare_use_robot_state_publisher_cmd = DeclareLaunchArgument(
        "use_robot_state_publisher",
        default_value="True",
        description="Publish TF using robot_state_publisher",
    )
    declare_custom_urdf_cmd = DeclareLaunchArgument(
        "custom_urdf",
        default_value=os.path.join(gps_wpf_dir, "models", "cuatri_real.urdf"),
        description="Path to custom URDF for TF tree",
    )
    declare_use_rviz_cmd = DeclareLaunchArgument(
        "use_rviz",
        default_value="False",
        description="Whether to start RVIZ",
    )
    declare_rviz_config_cmd = DeclareLaunchArgument(
        "rviz_config",
        default_value=rviz_default,
        description="Path to the RViz config file",
    )
    declare_use_mapviz_cmd = DeclareLaunchArgument(
        "use_mapviz",
        default_value="False",
        description="Whether to start mapviz",
    )
    declare_use_navsat_cmd = DeclareLaunchArgument(
        "use_navsat",
        default_value="True",
        description="Whether to start navsat_transform_node",
    )
    declare_use_collision_monitor_cmd = DeclareLaunchArgument(
        "use_collision_monitor",
        default_value="True",
        description="Whether to start collision monitor",
    )
    declare_use_gazebo_utils_cmd = DeclareLaunchArgument(
        "use_gazebo_utils",
        default_value="False",
        description="Whether to run gazebo_utils for frame normalization",
    )
    declare_use_pointcloud_to_laserscan_cmd = DeclareLaunchArgument(
        "use_pointcloud_to_laserscan",
        default_value="True",
        description="Whether to start pointcloud_to_laserscan",
    )
    declare_telemetry_backend_cmd = DeclareLaunchArgument(
        "telemetry_backend",
        default_value="mavros",
        description="Pixhawk telemetry backend: mavros or pixhawk_driver",
    )
    declare_start_lidar_cmd = DeclareLaunchArgument(
        "start_lidar",
        default_value="True",
        description="Start RS16 LiDAR driver",
    )
    declare_launch_web_cmd = DeclareLaunchArgument(
        "launch_web",
        default_value="False",
        description="Start sensores_web node",
    )
    declare_lidar_config_path_cmd = DeclareLaunchArgument(
        "lidar_config_path",
        default_value=lidar_default_config,
        description="Path to rs16 YAML config",
    )
    declare_ws_host_cmd = DeclareLaunchArgument(
        "ws_host",
        default_value="0.0.0.0",
        description="WebSocket host for map_tools web gateway",
    )
    declare_ws_port_cmd = DeclareLaunchArgument(
        "ws_port",
        default_value="8766",
        description="WebSocket port for map_tools web gateway",
    )
    declare_gps_topic_cmd = DeclareLaunchArgument(
        "gps_topic",
        default_value="/gps/fix",
        description="GPS topic used by web console backend/gateway",
    )
    declare_map_frame_cmd = DeclareLaunchArgument(
        "map_frame",
        default_value="map",
        description="Global map frame for navigation web backend",
    )
    declare_use_dual_gps_heading_cmd = DeclareLaunchArgument(
        "use_dual_gps_heading",
        default_value="auto",
        description="Dual-GPS heading mode: auto|true|false. 'auto' habilita dual si existe ublox_device",
    )
    declare_ublox_device_cmd = DeclareLaunchArgument(
        "ublox_device",
        default_value="/dev/ttyUSB1",
        description="Serial device for the rover ZED-F9P used for dual GPS heading",
    )
    declare_ublox_params_file_cmd = DeclareLaunchArgument(
        "ublox_params_file",
        default_value=_resolve_config_file_path(gps_wpf_dir, "ublox_dual_gps.yaml"),
        description="Path to ublox_gps YAML config file for moving-baseline heading",
    )
    declare_dual_gps_heading_output_topic_cmd = DeclareLaunchArgument(
        "dual_gps_heading_output_topic",
        default_value="/dual_gps/heading",
        description="Output IMU topic produced from ublox navheading",
    )
    declare_dual_gps_heading_output_frame_cmd = DeclareLaunchArgument(
        "dual_gps_heading_output_frame",
        default_value="base_link",
        description="Frame id for the dual GPS heading IMU",
    )
    declare_dual_gps_heading_yaw_offset_rad_cmd = DeclareLaunchArgument(
        "dual_gps_heading_yaw_offset_rad",
        default_value="0.0",
        description=(
            "Offset between ublox moving-baseline heading and vehicle-forward yaw. "
            "Current cuatri_real.urdf models a front/rear baseline, so 0.0 is the default."
        ),
    )

    nav2_only_cmd = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(gps_wpf_dir, "launch", "nav2_only.launch.py")),
        launch_arguments={
            "use_sim_time": use_sim_time,
            "map_frame": map_frame,
            "use_collision_monitor": use_collision_monitor,
            "use_rviz": use_rviz,
            "rviz_config": rviz_config,
            "use_robot_state_publisher": use_robot_state_publisher,
            "custom_urdf": custom_urdf,
        }.items(),
    )

    dual_gps_hw_cmd = OpaqueFunction(function=_build_dual_gps_heading_actions)
    ekf_nodes_cmd = OpaqueFunction(function=_build_ekf_nodes)

    zones_manager_cmd = Node(
        package="navegacion_gps",
        executable="zones_manager",
        name="zones_manager",
        output="screen",
        parameters=[
            {
                "fromll_service": "/fromLL",
                "fromll_service_fallback": "/navsat_transform/fromLL",
                "fromll_wait_timeout_s": 2.0,
                "load_map_service": "/keepout_filter_mask_server/load_map",
                "set_geojson_service": "/zones_manager/set_geojson",
                "get_state_service": "/zones_manager/get_state",
                "reload_from_disk_service": "/zones_manager/reload_from_disk",
                "map_frame": map_frame,
                "geojson_file": zones_geojson_path,
                "mask_image_file": keepout_mask_image_path,
                "mask_yaml_file": keepout_mask_yaml_path,
                "buffer_margin_m": 0.8,
                "degrade_enabled": True,
                "degrade_radius_m": 1.5,
                "degrade_edge_cost": 40,
                "degrade_min_cost": 1,
                "degrade_use_l2": True,
                "mask_origin_mode": "explicit",
                "mask_origin_x": -150.0,
                "mask_origin_y": -150.0,
                "mask_width": 3000,
                "mask_height": 3000,
                "mask_resolution": 0.1,
            }
        ],
    )
    nav_command_server_cmd = Node(
        package="navegacion_gps",
        executable="nav_command_server",
        name="nav_command_server",
        output="screen",
        parameters=[
            {
                "fromll_service": "/fromLL",
                "fromll_service_fallback": "/navsat_transform/fromLL",
                "fromll_wait_timeout_s": 2.0,
                "map_frame": map_frame,
                "gps_topic": gps_topic,
                "cmd_vel_safe_topic": "/cmd_vel_safe",
                "brake_topic": "/cmd_vel_safe",
                "manual_cmd_topic": "/cmd_vel_safe",
                "teleop_cmd_topic": "/cmd_vel_teleop",
                "brake_publish_count": 5,
                "brake_publish_interval_s": 0.1,
                "manual_cmd_timeout_s": 0.4,
                "manual_watchdog_hz": 10.0,
                "nav_telemetry_hz": 5.0,
                "telemetry_topic": "/nav_command_server/telemetry",
                "set_goal_service": "/nav_command_server/set_goal_ll",
                "cancel_goal_service": "/nav_command_server/cancel_goal",
                "brake_service": "/nav_command_server/brake",
                "set_manual_mode_service": "/nav_command_server/set_manual_mode",
                "get_state_service": "/nav_command_server/get_state",
            }
        ],
    )
    nav_snapshot_server_cmd = Node(
        package="navegacion_gps",
        executable="nav_snapshot_server",
        name="nav_snapshot_server",
        output="screen",
        parameters=[
            {
                "get_snapshot_service": "/nav_snapshot_server/get_nav_snapshot",
                "local_costmap_topic": "/local_costmap/costmap",
                "global_costmap_topic": "/global_costmap/costmap",
                "keepout_mask_topic": "/keepout_filter_mask",
                "local_footprint_topic": "/local_costmap/published_footprint",
                "stop_zone_topic": "/stop_zone",
                "collision_polygons_topic": "/collision_monitor/polygons",
                "scan_topic": "/scan",
                "plan_topic": "/plan",
                "base_frame": "base_footprint",
                "snapshot_extent_m": 30.0,
                "snapshot_size_px": 512,
                "snapshot_global_inset_px": 160,
                "snapshot_timeout_ms": 500,
            }
        ],
    )
    nav_observability_cmd = Node(
        package="navegacion_gps",
        executable="nav_observability",
        name="nav_observability",
        output="screen",
        parameters=[
            {
                "use_sim_time": ParameterValue(use_sim_time, value_type=bool),
                "publish_hz": 2.0,
            }
        ],
    )

    no_go_editor_cmd = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(map_tools_dir, "launch", "no_go_editor.launch.py")
        ),
        launch_arguments={
            "ws_host": ws_host,
            "ws_port": ws_port,
            "gps_topic": gps_topic,
            "map_frame": map_frame,
            "launch_zones_manager": "false",
            "launch_nav_command_server": "false",
            "launch_nav_snapshot_server": "false",
            "teleop_cmd_topic": "/cmd_vel_teleop",
            "zones_set_geojson_service": "/zones_manager/set_geojson",
            "zones_get_state_service": "/zones_manager/get_state",
            "zones_reload_service": "/zones_manager/reload_from_disk",
        }.items(),
    )

    mapviz_cmd = Node(
        package="mapviz",
        executable="mapviz",
        name="mapviz",
        output="screen",
        condition=IfCondition(use_mapviz),
        parameters=[{"use_sim_time": ParameterValue(use_sim_time, value_type=bool)}],
    )

    gazebo_utils_cmd = Node(
        package="navegacion_gps",
        executable="gazebo_utils",
        name="gazebo_utils",
        output="screen",
        parameters=[
            {"use_sim_time": ParameterValue(use_sim_time, value_type=bool)},
            {"imu_in_topic": "/imu/data_raw", "imu_out_topic": "/imu/data"},
            {"gps_in_topic": "/gps/fix_raw", "gps_out_topic": "/gps/fix"},
            {"lidar_in_topic": "/scan_3d_raw", "lidar_out_topic": "/scan_3d"},
            {"odom_in_topic": "/odom_raw", "odom_out_topic": "/odom"},
            {"imu_frame_id": "imu_link"},
            {"gps_frame_id": "gps_link"},
            {"lidar_frame_id": "lidar_link"},
            {"odom_frame_id": "odom"},
            {"base_link_frame_id": "base_footprint"},
            {"enable_cmd_vel_final_bridge": False},
        ],
        condition=IfCondition(use_gazebo_utils),
    )

    lidar_to_scan_cmd = Node(
        package="pointcloud_to_laserscan",
        executable="pointcloud_to_laserscan_node",
        name="pointcloud_to_laserscan",
        output="screen",
        parameters=[
            lidar_to_scan_params,
            {"use_sim_time": ParameterValue(use_sim_time, value_type=bool)},
            {"output_qos": "sensor_data"},
        ],
        remappings=[("cloud_in", "/scan_3d"), ("scan", "/scan")],
        condition=IfCondition(use_pointcloud_to_laserscan),
    )

    mavros_cmd = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(sensores_dir, "launch", "mavros.launch.py")
        ),
        launch_arguments={
            "launch_web": launch_web,
            "launch_legacy_compat": "true",
        }.items(),
        condition=IfCondition(
            PythonExpression(["'", telemetry_backend, "' == 'mavros'"])
        ),
    )

    pixhawk_cmd = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(sensores_dir, "launch", "pixhawk.launch.py")
        ),
        launch_arguments={
            "launch_web": launch_web,
        }.items(),
        condition=IfCondition(
            PythonExpression(["'", telemetry_backend, "' == 'pixhawk_driver'"])
        ),
    )

    camera_cmd = Node(
        package="sensores",
        executable="camara",
        name="camara",
        output="screen",
    )

    lidar_cmd = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(sensores_dir, "launch", "rs16.launch.py")
        ),
        launch_arguments={"config_path": lidar_config_path}.items(),
        condition=IfCondition(start_lidar),
    )

    ld = LaunchDescription()
    ld.add_action(declare_use_sim_time_cmd)
    ld.add_action(declare_use_robot_state_publisher_cmd)
    ld.add_action(declare_custom_urdf_cmd)
    ld.add_action(declare_use_rviz_cmd)
    ld.add_action(declare_rviz_config_cmd)
    ld.add_action(declare_use_mapviz_cmd)
    ld.add_action(declare_use_navsat_cmd)
    ld.add_action(declare_use_collision_monitor_cmd)
    ld.add_action(declare_use_gazebo_utils_cmd)
    ld.add_action(declare_use_pointcloud_to_laserscan_cmd)
    ld.add_action(declare_telemetry_backend_cmd)
    ld.add_action(declare_start_lidar_cmd)
    ld.add_action(declare_launch_web_cmd)
    ld.add_action(declare_lidar_config_path_cmd)
    ld.add_action(declare_ws_host_cmd)
    ld.add_action(declare_ws_port_cmd)
    ld.add_action(declare_gps_topic_cmd)
    ld.add_action(declare_map_frame_cmd)
    ld.add_action(declare_use_dual_gps_heading_cmd)
    ld.add_action(declare_ublox_device_cmd)
    ld.add_action(declare_ublox_params_file_cmd)
    ld.add_action(declare_dual_gps_heading_output_topic_cmd)
    ld.add_action(declare_dual_gps_heading_output_frame_cmd)
    ld.add_action(declare_dual_gps_heading_yaw_offset_rad_cmd)
    ld.add_action(OpaqueFunction(function=_validate_telemetry_backend))
    ld.add_action(OpaqueFunction(function=_validate_real_dual_gps_configuration))

    ld.add_action(nav2_only_cmd)
    ld.add_action(mavros_cmd)
    ld.add_action(pixhawk_cmd)
    ld.add_action(camera_cmd)
    ld.add_action(lidar_cmd)
    ld.add_action(dual_gps_hw_cmd)
    ld.add_action(ekf_nodes_cmd)
    ld.add_action(zones_manager_cmd)
    ld.add_action(nav_command_server_cmd)
    ld.add_action(nav_snapshot_server_cmd)
    ld.add_action(nav_observability_cmd)
    ld.add_action(no_go_editor_cmd)
    ld.add_action(mapviz_cmd)
    ld.add_action(gazebo_utils_cmd)
    ld.add_action(lidar_to_scan_cmd)

    return ld

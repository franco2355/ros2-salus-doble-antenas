import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description():
    gps_wpf_dir = get_package_share_directory("navegacion_gps")

    wheelbase_m = LaunchConfiguration("wheelbase_m")
    invert_measured_steer_sign = LaunchConfiguration("invert_measured_steer_sign")
    pose_covariance_xy = LaunchConfiguration("pose_covariance_xy")
    pose_covariance_yaw = LaunchConfiguration("pose_covariance_yaw")
    twist_covariance_vx = LaunchConfiguration("twist_covariance_vx")
    twist_covariance_vy = LaunchConfiguration("twist_covariance_vy")
    twist_covariance_yaw_rate = LaunchConfiguration("twist_covariance_yaw_rate")
    global_localization_params_file = LaunchConfiguration("global_localization_params_file")
    enable_map_gps_absolute_measurement = LaunchConfiguration(
        "enable_map_gps_absolute_measurement"
    )
    map_gps_absolute_topic = LaunchConfiguration("map_gps_absolute_topic")
    map_gps_pose_covariance_xy = LaunchConfiguration("map_gps_pose_covariance_xy")
    map_gps_fromll_service = LaunchConfiguration("map_gps_fromll_service")
    map_gps_fromll_service_fallback = LaunchConfiguration("map_gps_fromll_service_fallback")
    map_gps_fromll_wait_timeout_s = LaunchConfiguration("map_gps_fromll_wait_timeout_s")
    navsat_use_odometry_yaw = LaunchConfiguration("navsat_use_odometry_yaw")
    enable_gps_course_heading = LaunchConfiguration("enable_gps_course_heading")
    gps_course_heading_min_distance_m = LaunchConfiguration(
        "gps_course_heading_min_distance_m"
    )
    gps_course_heading_min_speed_mps = LaunchConfiguration("gps_course_heading_min_speed_mps")
    gps_course_heading_max_abs_steer_deg = LaunchConfiguration(
        "gps_course_heading_max_abs_steer_deg"
    )
    gps_course_heading_max_abs_yaw_rate_rps = LaunchConfiguration(
        "gps_course_heading_max_abs_yaw_rate_rps"
    )
    gps_course_heading_invalid_hold_s = LaunchConfiguration(
        "gps_course_heading_invalid_hold_s"
    )
    gps_course_heading_max_sample_dt_s = LaunchConfiguration(
        "gps_course_heading_max_sample_dt_s"
    )
    gps_course_heading_publish_hz = LaunchConfiguration("gps_course_heading_publish_hz")
    gps_course_heading_yaw_variance_rad2 = LaunchConfiguration(
        "gps_course_heading_yaw_variance_rad2"
    )
    gps_course_heading_hold_yaw_variance_multiplier = LaunchConfiguration(
        "gps_course_heading_hold_yaw_variance_multiplier"
    )
    gps_course_heading_require_rtk = LaunchConfiguration("gps_course_heading_require_rtk")
    gps_course_heading_allowed_rtk_statuses = LaunchConfiguration(
        "gps_course_heading_allowed_rtk_statuses"
    )
    gps_course_heading_rtk_status_max_age_s = LaunchConfiguration(
        "gps_course_heading_rtk_status_max_age_s"
    )
    gps_rtk_status_topic = LaunchConfiguration("gps_rtk_status_topic")
    datum_lat = LaunchConfiguration("datum_lat")
    datum_lon = LaunchConfiguration("datum_lon")
    datum_yaw_deg = LaunchConfiguration("datum_yaw_deg")

    return LaunchDescription(
        [
            DeclareLaunchArgument("use_sim_time", default_value="True"),
            DeclareLaunchArgument("wheelbase_m", default_value="0.94"),
            DeclareLaunchArgument("invert_measured_steer_sign", default_value="True"),
            DeclareLaunchArgument("pose_covariance_xy", default_value="0.05"),
            DeclareLaunchArgument("pose_covariance_yaw", default_value="0.1"),
            DeclareLaunchArgument("twist_covariance_vx", default_value="0.05"),
            DeclareLaunchArgument("twist_covariance_vy", default_value="0.01"),
            DeclareLaunchArgument("twist_covariance_yaw_rate", default_value="0.1"),
            DeclareLaunchArgument(
                "global_localization_params_file",
                default_value=os.path.join(gps_wpf_dir, "config", "localization_global_v2.yaml"),
            ),
            DeclareLaunchArgument("enable_map_gps_absolute_measurement", default_value="true"),
            DeclareLaunchArgument("map_gps_absolute_topic", default_value="/gps/odometry_map"),
            DeclareLaunchArgument("map_gps_pose_covariance_xy", default_value="0.05"),
            DeclareLaunchArgument("map_gps_fromll_service", default_value="/fromLL"),
            DeclareLaunchArgument(
                "map_gps_fromll_service_fallback",
                default_value="/navsat_transform/fromLL",
            ),
            DeclareLaunchArgument("map_gps_fromll_wait_timeout_s", default_value="0.2"),
            DeclareLaunchArgument("navsat_use_odometry_yaw", default_value="true"),
            DeclareLaunchArgument("enable_gps_course_heading", default_value="true"),
            DeclareLaunchArgument("gps_course_heading_min_distance_m", default_value="2.0"),
            DeclareLaunchArgument("gps_course_heading_min_speed_mps", default_value="0.8"),
            DeclareLaunchArgument("gps_course_heading_max_abs_steer_deg", default_value="3.0"),
            DeclareLaunchArgument(
                "gps_course_heading_max_abs_yaw_rate_rps",
                default_value="0.05",
            ),
            DeclareLaunchArgument("gps_course_heading_invalid_hold_s", default_value="0.8"),
            DeclareLaunchArgument("gps_course_heading_max_sample_dt_s", default_value="2.5"),
            DeclareLaunchArgument("gps_course_heading_publish_hz", default_value="5.0"),
            DeclareLaunchArgument(
                "gps_course_heading_yaw_variance_rad2",
                default_value="0.05",
            ),
            DeclareLaunchArgument(
                "gps_course_heading_hold_yaw_variance_multiplier",
                default_value="4.0",
            ),
            # El bag original no incluye el topic RTK. Por default el replay
            # lo desactiva para poder recalcular el heading offline.
            DeclareLaunchArgument("gps_course_heading_require_rtk", default_value="false"),
            DeclareLaunchArgument(
                "gps_course_heading_allowed_rtk_statuses",
                default_value="RTK_FIXED,RTK_FIX,RTK_FLOAT,RTCM_OK",
            ),
            DeclareLaunchArgument(
                "gps_course_heading_rtk_status_max_age_s",
                default_value="2.5",
            ),
            DeclareLaunchArgument("gps_rtk_status_topic", default_value="/gps/rtk_status_mavros"),
            DeclareLaunchArgument("datum_lat", default_value="-31.4858037"),
            DeclareLaunchArgument("datum_lon", default_value="-64.2410570"),
            DeclareLaunchArgument("datum_yaw_deg", default_value="0.0"),
            Node(
                package="navegacion_gps",
                executable="gps_course_heading",
                name="gps_course_heading",
                output="screen",
                condition=IfCondition(enable_gps_course_heading),
                parameters=[
                    {
                        "use_sim_time": True,
                        "gps_topic": "/gps/fix",
                        "odom_topic": "/odometry/local",
                        "drive_telemetry_topic": "/controller/drive_telemetry",
                        "output_topic": "/gps/course_heading",
                        "debug_topic": "/gps/course_heading/debug",
                        "base_frame": "base_footprint",
                        "min_distance_m": ParameterValue(
                            gps_course_heading_min_distance_m, value_type=float
                        ),
                        "min_speed_mps": ParameterValue(
                            gps_course_heading_min_speed_mps, value_type=float
                        ),
                        "max_abs_steer_deg": ParameterValue(
                            gps_course_heading_max_abs_steer_deg, value_type=float
                        ),
                        "max_abs_yaw_rate_rps": ParameterValue(
                            gps_course_heading_max_abs_yaw_rate_rps, value_type=float
                        ),
                        "invalid_hold_s": ParameterValue(
                            gps_course_heading_invalid_hold_s, value_type=float
                        ),
                        "max_sample_dt_s": ParameterValue(
                            gps_course_heading_max_sample_dt_s, value_type=float
                        ),
                        "publish_hz": ParameterValue(
                            gps_course_heading_publish_hz, value_type=float
                        ),
                        "yaw_variance_rad2": ParameterValue(
                            gps_course_heading_yaw_variance_rad2, value_type=float
                        ),
                        "hold_yaw_variance_multiplier": ParameterValue(
                            gps_course_heading_hold_yaw_variance_multiplier,
                            value_type=float,
                        ),
                        "rtk_status_topic": gps_rtk_status_topic,
                        "require_rtk": ParameterValue(
                            gps_course_heading_require_rtk, value_type=bool
                        ),
                        "allowed_rtk_statuses": gps_course_heading_allowed_rtk_statuses,
                        "rtk_status_max_age_s": ParameterValue(
                            gps_course_heading_rtk_status_max_age_s, value_type=float
                        ),
                    }
                ],
            ),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    os.path.join(gps_wpf_dir, "launch", "localization_global_v2.launch.py")
                ),
                launch_arguments={
                    "use_sim_time": "true",
                    "drive_telemetry_topic": "/controller/drive_telemetry",
                    "imu_topic": "/imu/data",
                    "gps_topic": "/gps/fix",
                    "wheelbase_m": wheelbase_m,
                    "invert_measured_steer_sign": invert_measured_steer_sign,
                    "pose_covariance_xy": pose_covariance_xy,
                    "pose_covariance_yaw": pose_covariance_yaw,
                    "twist_covariance_vx": twist_covariance_vx,
                    "twist_covariance_vy": twist_covariance_vy,
                    "twist_covariance_yaw_rate": twist_covariance_yaw_rate,
                    "enable_map_gps_absolute_measurement": enable_map_gps_absolute_measurement,
                    "map_gps_absolute_topic": map_gps_absolute_topic,
                    "map_gps_pose_covariance_xy": map_gps_pose_covariance_xy,
                    "map_gps_fromll_service": map_gps_fromll_service,
                    "map_gps_fromll_service_fallback": map_gps_fromll_service_fallback,
                    "map_gps_fromll_wait_timeout_s": map_gps_fromll_wait_timeout_s,
                    "navsat_use_odometry_yaw": navsat_use_odometry_yaw,
                    "global_localization_params_file": global_localization_params_file,
                    "enable_gps_course_heading": enable_gps_course_heading,
                    "gps_course_heading_topic": "/gps/course_heading",
                    "datum_setter": "false",
                    "datum_lat": datum_lat,
                    "datum_lon": datum_lon,
                    "datum_yaw_deg": datum_yaw_deg,
                }.items(),
            ),
        ]
    )

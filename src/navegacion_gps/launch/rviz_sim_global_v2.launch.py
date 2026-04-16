import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def _read_file(path):
    with open(path, "r", encoding="utf-8") as file_handle:
        return file_handle.read()


def _build_robot_state_publisher(context):
    use_sim_time = LaunchConfiguration("use_sim_time").perform(context)
    custom_urdf = LaunchConfiguration("custom_urdf").perform(context)
    use_sim_time_bool = use_sim_time == "True"

    robot_description = _read_file(custom_urdf)

    return [
        Node(
            package="robot_state_publisher",
            executable="robot_state_publisher",
            name="robot_state_publisher",
            output="screen",
            parameters=[
                {
                    "use_sim_time": use_sim_time_bool,
                    "robot_description": robot_description,
                }
            ],
        )
    ]


def generate_launch_description():
    gps_wpf_dir = get_package_share_directory("navegacion_gps")
    default_rviz = os.path.join(gps_wpf_dir, "config", "rviz_global_v2.rviz")
    default_urdf = os.path.join(gps_wpf_dir, "models", "cuatri_2gps.urdf")

    use_sim_time = LaunchConfiguration("use_sim_time")
    rviz_config = LaunchConfiguration("rviz_config")
    navheading_topic = LaunchConfiguration("navheading_topic")
    navheading_pose_topic = LaunchConfiguration("navheading_pose_topic")
    course_heading_topic = LaunchConfiguration("course_heading_topic")
    course_heading_pose_topic = LaunchConfiguration("course_heading_pose_topic")

    return LaunchDescription(
        [
            DeclareLaunchArgument(
                "use_sim_time",
                default_value="True",
                description="Use simulation clock if true",
            ),
            DeclareLaunchArgument(
                "rviz_config",
                default_value=default_rviz,
                description="Path to the RViz config file",
            ),
            DeclareLaunchArgument(
                "custom_urdf",
                default_value=default_urdf,
                description="Path to custom URDF for RViz RobotModel",
            ),
            DeclareLaunchArgument(
                "navheading_topic",
                default_value="/ublox_rover/navheading",
                description="Raw ublox navheading topic to visualize in RViz",
            ),
            DeclareLaunchArgument(
                "navheading_pose_topic",
                default_value="/ublox_rover/navheading_pose",
                description="Pose topic derived from navheading for RViz display",
            ),
            DeclareLaunchArgument(
                "course_heading_topic",
                default_value="/gps/course_heading",
                description="Raw GPS course heading topic to visualize in RViz",
            ),
            DeclareLaunchArgument(
                "course_heading_pose_topic",
                default_value="/gps/course_heading_pose",
                description="Pose topic derived from GPS course heading for RViz display",
            ),
            DeclareLaunchArgument(
                "launch_robot_state_publisher",
                default_value="false",
                description=(
                    "Launch a local robot_state_publisher for RViz "
                    "when no other publisher is running"
                ),
            ),
            OpaqueFunction(
                function=_build_robot_state_publisher,
                condition=IfCondition(LaunchConfiguration("launch_robot_state_publisher")),
            ),
            Node(
                package="navegacion_gps",
                executable="navheading_pose_bridge",
                name="navheading_pose_bridge",
                output="screen",
                parameters=[
                    {
                        "use_sim_time": ParameterValue(use_sim_time, value_type=bool),
                        "input_topic": navheading_topic,
                        "output_topic": navheading_pose_topic,
                    }
                ],
            ),
            Node(
                package="navegacion_gps",
                executable="navheading_pose_bridge",
                name="course_heading_pose_bridge",
                output="screen",
                parameters=[
                    {
                        "use_sim_time": ParameterValue(use_sim_time, value_type=bool),
                        "input_topic": course_heading_topic,
                        "output_topic": course_heading_pose_topic,
                    }
                ],
            ),
            Node(
                package="rviz2",
                executable="rviz2",
                name="rviz2",
                output="screen",
                arguments=[
                    "-d",
                    rviz_config,
                    "--ros-args",
                    "-p",
                    PythonExpression(["'use_sim_time:=' + str(", use_sim_time, ")"]),
                ],
                parameters=[{"use_sim_time": ParameterValue(use_sim_time, value_type=bool)}],
            ),
        ]
    )

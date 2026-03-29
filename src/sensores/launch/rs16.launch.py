from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, SetEnvironmentVariable
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    config_path = LaunchConfiguration('config_path')
    launch_rviz = LaunchConfiguration('rviz')
    use_cyclone_dds = LaunchConfiguration('use_cyclone_dds')
    default_config = PathJoinSubstitution(
        [FindPackageShare('sensores'), 'config', 'rs16.yaml']
    )
    rviz_config = PathJoinSubstitution(
        [FindPackageShare('rslidar_sdk'), 'rviz', 'rviz2.rviz']
    )

    return LaunchDescription(
        [
            DeclareLaunchArgument(
                'use_cyclone_dds',
                default_value='false',
                description='Force Cyclone DDS for this launch if true',
            ),
            SetEnvironmentVariable(
                name='RMW_IMPLEMENTATION',
                value='rmw_cyclonedds_cpp',
                condition=IfCondition(use_cyclone_dds),
            ),
            DeclareLaunchArgument(
                'config_path',
                default_value=default_config,
                description='Path to the rslidar_sdk config YAML',
            ),
            DeclareLaunchArgument(
                'rviz',
                default_value='false',
                description='Launch RViz2 with the rslidar_sdk config',
            ),
            Node(
                package='rslidar_sdk',
                executable='rslidar_sdk_node',
                output='screen',
                parameters=[{'config_path': config_path}],
            ),
            Node(
                package='rviz2',
                executable='rviz2',
                name='rviz2',
                output='screen',
                arguments=['-d', rviz_config],
                condition=IfCondition(launch_rviz),
            ),
        ]
    )

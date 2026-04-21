from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description() -> LaunchDescription:
    pkg_share = FindPackageShare('lidar_camara')

    params_file = LaunchConfiguration('params_file')
    enable_brake_guard = LaunchConfiguration('enable_brake_guard')
    enable_recovery = LaunchConfiguration('enable_recovery')

    return LaunchDescription([
        DeclareLaunchArgument(
            'params_file',
            default_value=PathJoinSubstitution([pkg_share, 'config', 'fusion.yaml']),
            description='Path to the YAML parameters file',
        ),
        DeclareLaunchArgument(
            'enable_brake_guard',
            default_value='false',
            description=(
                'Start vision_brake_guard (calls /nav_command_server/brake). '
                'Enable only when nav_command_server is running. '
                'Note: disable if enable_recovery:=true to avoid conflicts.'
            ),
        ),
        DeclareLaunchArgument(
            'enable_recovery',
            default_value='false',
            description=(
                'Start obstacle_recovery: brake → backup → resume Nav2. '
                'Requires nav_command_server running. '
                'Preferred over enable_brake_guard for autonomous navigation.'
            ),
        ),

        # ── Main fusion node ─────────────────────────────────────────────
        # Subscribes /detections + /scan_3d, publishes /fusion/*.
        # Runs at worker_hz (default 10 Hz), decoupled from the Nav2/control loop.
        Node(
            package='lidar_camara',
            executable='fusion_node',
            name='lidar_camara_fusion',
            output='screen',
            parameters=[params_file],
        ),

        # ── Obstacle recovery (recomendado para navegación autónoma) ─────
        # brake_active x N → modo manual → retrocede → retoma Nav2.
        # Nav2 replana alrededor del obstáculo usando su costmap LiDAR.
        Node(
            package='lidar_camara',
            executable='obstacle_recovery',
            name='obstacle_recovery',
            output='screen',
            parameters=[params_file],
            condition=IfCondition(enable_recovery),
        ),

        # ── Brake guard simple (alternativa sin maniobra de retroceso) ───
        # Solo llama /nav_command_server/brake. No retrocede ni retoma.
        # Usar cuando no se quiere maniobra automática.
        Node(
            package='lidar_camara',
            executable='vision_brake_guard',
            name='vision_brake_guard',
            output='screen',
            parameters=[params_file],
            condition=IfCondition(enable_brake_guard),
        ),
    ])

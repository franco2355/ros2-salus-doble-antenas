from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    launch_web = LaunchConfiguration('launch_web')
    serial_port = LaunchConfiguration('serial_port')
    baudrate = LaunchConfiguration('baudrate')
    odom_frame = LaunchConfiguration('odom_frame')
    base_link_frame = LaunchConfiguration('base_link_frame')
    imu_frame = LaunchConfiguration('imu_frame')
    gps_frame = LaunchConfiguration('gps_frame')
    yaw_correction_deg = LaunchConfiguration('yaw_correction_deg')
    enable_gps_rtk = LaunchConfiguration('enable_gps_rtk')
    enable_rtcm_tcp = LaunchConfiguration('enable_rtcm_tcp')
    rtcm_tcp_host = LaunchConfiguration('rtcm_tcp_host')
    rtcm_tcp_port = LaunchConfiguration('rtcm_tcp_port')
    rtcm_topic = LaunchConfiguration('rtcm_topic')

    return LaunchDescription(
        [
            DeclareLaunchArgument(
                'launch_web',
                default_value='false',
                description='Launch the sensores_web node',
            ),
            DeclareLaunchArgument(
                'serial_port',
                default_value='/dev/ttyACM0',
                description='Pixhawk serial port',
            ),
            DeclareLaunchArgument(
                'baudrate',
                default_value='921600',
                description='Pixhawk MAVLink baudrate',
            ),
            DeclareLaunchArgument(
                'odom_frame',
                default_value='odom',
                description='Odometry frame id',
            ),
            DeclareLaunchArgument(
                'base_link_frame',
                default_value='base_footprint',
                description='Robot base frame id (child of odom)',
            ),
            DeclareLaunchArgument(
                'imu_frame',
                default_value='imu_link',
                description='IMU frame id',
            ),
            DeclareLaunchArgument(
                'gps_frame',
                default_value='gps_link',
                description='GPS frame id',
            ),
            DeclareLaunchArgument(
                'yaw_correction_deg',
                default_value='0.0',
                description='Global yaw correction applied by pixhawk_driver (degrees)',
            ),
            DeclareLaunchArgument(
                'enable_gps_rtk',
                default_value='true',
                description='Request optional GPS_RTK diagnostics from Pixhawk',
            ),
            DeclareLaunchArgument(
                'enable_rtcm_tcp',
                default_value='true',
                description='Read RTCM corrections from a TCP source inside pixhawk_driver',
            ),
            DeclareLaunchArgument(
                'rtcm_tcp_host',
                default_value='127.0.0.1',
                description='Host for the incoming RTCM TCP stream',
            ),
            DeclareLaunchArgument(
                'rtcm_tcp_port',
                default_value='2102',
                description='Port for the incoming RTCM TCP stream',
            ),
            DeclareLaunchArgument(
                'rtcm_topic',
                default_value='/rtcm',
                description='Optional ROS topic carrying RTCM bytes',
            ),
            Node(
                package='sensores',
                executable='pixhawk_driver',
                name='pixhawk_driver',
                output='screen',
                parameters=[
                    {'serial_port': serial_port},
                    {'baudrate': baudrate},
                    {'odom_frame': odom_frame},
                    {'base_link_frame': base_link_frame},
                    {'imu_frame': imu_frame},
                    {'gps_frame': gps_frame},
                    {'yaw_correction_deg': yaw_correction_deg},
                    {'enable_gps_rtk': enable_gps_rtk},
                    {'enable_rtcm_tcp': enable_rtcm_tcp},
                    {'rtcm_tcp_host': rtcm_tcp_host},
                    {'rtcm_tcp_port': rtcm_tcp_port},
                    {'rtcm_topic': rtcm_topic},
                ],
            ),
            Node(
                package='sensores',
                executable='sensores_web',
                name='sensores_web',
                output='screen',
                condition=IfCondition(launch_web),
            ),
        ]
    )

# AGENTS

## Project context
- Project: ROS2_SALUS, autonomous patrol quadricycle with Ackermann steering
- Platform: Raspberry Pi 5
- ROS 2 distro: Humble
- Main workflow: Docker workspace
- Navigation stack: Nav2 + robot_localization
- Hardware: Pixhawk 6X, GNSS F9P, RoboSense RS16, wheel odometry

## Access
- Robot SSH target: `ssh salus`

## Paths
- Host workspace: `/home/leo/codigo/ROS2_SALUS`
- Container workspace: `/ros2_ws`
- Robot workspace: `~/ros2_ws`
- Controller reference code on robot: `~/codigo/RASPY_SALUS`

## Packages in this checkout
- Own packages:
  - `src/interfaces`
  - `src/controller_server`
  - `src/map_tools`
  - `src/navegacion_gps`
  - `src/sensores`
- Vendored third-party packages:
  - `src/rslidar_msg`
  - `src/rslidar_sdk`

## Canonical launch entry points
- Navigation currently used:
  - `ros2 launch navegacion_gps sim_global_v2.launch.py`
  - `ros2 launch navegacion_gps real_global_v2.launch.py`
  - `ros2 launch navegacion_gps rviz_real_global_v2.launch.py`
- Legacy/reference navigation only:
  - `ros2 launch navegacion_gps simulacion.launch.py`
  - `ros2 launch navegacion_gps real.launch.py`
  - `ros2 launch navegacion_gps rviz_real.launch.py`
  - `ros2 launch navegacion_gps sim_local_v2.launch.py`
  - `ros2 launch navegacion_gps real_local_v2.launch.py`
- `ros2 launch sensores pixhawk.launch.py`
- `ros2 launch sensores rs16.launch.py`
- `ros2 launch map_tools no_go_editor.launch.py`
- `ros2 launch controller_server controller_server.launch.py`

## Runtime architecture notes
- Control flow:
  - Nav2 publishes `/cmd_vel`
  - `nav2_collision_monitor` publishes `/cmd_vel_safe`
  - `nav_command_server` arbitrates `/cmd_vel_safe` and manual web commands
  - `nav_command_server` publishes `/cmd_vel_final`
  - `controller_server` consumes `/cmd_vel_final`
- Manual web control:
  - `/cmd_vel_teleop` uses `interfaces/msg/CmdVelFinal`
  - `map_tools/web_zone_server` publishes manual commands
  - `navegacion_gps/nav_command_server` consumes them
- LiDAR path:
  - RS16 publishes `/scan_3d`
  - `pointcloud_to_laserscan` publishes `/scan`
- Localization:
  - inputs: `/imu/data`, `/gps/fix`, `/odom`
  - outputs: `/odometry/local`, `/odometry/gps`
  - TF: `map -> odom -> base_footprint`

## Practical scripts
- `./tools/exec.sh`
- `./tools/compile-ros.sh`
- `./tools/launch_real_global_v2.sh`
- `./tools/launch_real_global_v2_rviz.sh`
- `./tools/launch_controller.sh`
- `./tools/launch_no_go_editor.sh`
- `./tools/healthcheck-lidar.sh`

## Repository caveats
- `ROS2_SALUS` is a single git repository rooted at `/home/leo/codigo/ROS2_SALUS`.
- `src/*` are regular package directories inside the monorepo, not nested git repositories.
- `rslidar_sdk` and `rslidar_msg` are vendored third-party code; prefer local wrappers/docs over patching upstream files unless explicitly requested.
- Some historical docs and helper scripts still mention old navigation profiles. Treat every navigation other than `real_global_v2` and `sim_global_v2` as legacy/reference unless explicitly requested.

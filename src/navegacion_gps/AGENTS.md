# AGENTS.md

Role
- You are editing the `navegacion_gps` package in a ROS 2 Humble workspace.
- Prefer small, safe changes and keep launch arguments, YAML params, topics, and frames aligned.

Quick map
- `launch/`: canonical entry points are `simulacion.launch.py`, `real.launch.py`, `rviz_real.launch.py`.
- `navegacion_gps/`: active nodes are `gazebo_utils.py`, `zones_manager.py`, `nav_command_server.py`, `nav_snapshot_server.py`.
- `config/`: Nav2, collision monitor, robot_localization, keepout mask assets, RViz.
- `models/`, `worlds/`: simulation assets.

Runtime truth
- `/cmd_vel_safe` is the filtered Nav2 output.
- `/cmd_vel_teleop` uses `interfaces/msg/CmdVelFinal`.
- `nav_command_server` publishes `/cmd_vel_final`.
- `controller_server` consumes `/cmd_vel_final`.
- Localization stack expects `/imu/data`, `/gps/fix`, `/odom` and publishes `/odometry/local`, `/odometry/gps`.

Launch guidance
- `simulacion.launch.py` is the full simulation entry point.
- `real.launch.py` is the real-robot bringup entry point.
- `rviz_real.launch.py` is visualization only.
- Do not reintroduce references to removed launches such as `navegacion.launch.py`, `dual_ekf_navsat.launch.py`, or `mapviz.launch.py`.

Editing guidance
- When changing a topic or frame, update:
  - launch arguments,
  - YAML config,
  - README if user-facing behavior changes.
- Keep `zones_manager`, `nav_command_server`, and `nav_snapshot_server` service names stable unless explicitly requested.
- Avoid broad refactors in `models/` or `worlds/` unless needed for the task.

Validation
- Preferred validation path is inside the Docker workspace:
  - `./tools/compile-ros.sh navegacion_gps`
  - `ros2 launch navegacion_gps real.launch.py --show-args`
  - `ros2 launch navegacion_gps simulacion.launch.py --show-args`

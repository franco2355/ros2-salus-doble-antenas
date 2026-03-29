# Arquitectura Runtime

Estado: actual
Alcance: contratos de tópicos y flujo de control del stack SALUS
Fuente de verdad: README de paquetes, launches y nodos activos del checkout

## Flujo de control principal
```text
Nav2
-> /cmd_vel
-> nav2_collision_monitor
-> /cmd_vel_safe
-> nav_command_server
-> /cmd_vel_final
-> controller_server
-> actuador real o backend sim_gazebo
```

## Control manual web
```text
map_tools/web_zone_server
-> /cmd_vel_teleop (interfaces/msg/CmdVelFinal)
-> nav_command_server
-> /cmd_vel_final
-> controller_server
```

## Sensores y percepción
```text
RS16
-> /scan_3d
-> pointcloud_to_laserscan
-> /scan
```

## Localización mainline
- Entradas típicas:
  - `/imu/data`
  - `/gps/fix`
  - `/odom`
- Salidas:
  - `/odometry/local`
  - `/odometry/gps`
- TF esperada:
  - `map -> odom -> base_footprint`

## Localización V2 local
- Entrada de movimiento:
  - `/controller/drive_telemetry`
- Procesamiento:
  - `ackermann_odometry`
  - EKF local en `odom`
- Salida:
  - `/odometry/local`
- TF:
  - `odom -> base_footprint`

## Localización V2 global
- Base local:
  - `/odometry/local`
- Capa global:
  - `navsat_transform`
  - `/odometry/gps`
  - EKF global
- Salida:
  - `/odometry/global`
- TF:
  - `map -> odom -> base_footprint`

## Nodos clave por responsabilidad
- Arbitraje y navegación:
  - `navegacion_gps/nav_command_server`
  - `navegacion_gps/zones_manager`
  - `navegacion_gps/nav_snapshot_server`
  - `navegacion_gps/nav_observability`
- Actuación:
  - `controller_server/controller_server_node`
- Sensores:
  - `sensores/pixhawk_driver`
  - `sensores/mavros_compat_bridge`
  - `rslidar_sdk`
- Web:
  - `map_tools/web_zone_server`
  - `sensores/sensores_web`

## Dónde mirar cuando algo falla
- Estado y eventos de navegación:
  - `/nav_command_server/telemetry`
  - `/nav_command_server/events`
- Estado y telemetría del controlador:
  - `/controller/status`
  - `/controller/telemetry`
  - `/controller/drive_telemetry`
- Diagnóstico global:
  - `/diagnostics`

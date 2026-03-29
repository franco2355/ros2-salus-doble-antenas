# navegacion_gps

Paquete de navegación del workspace. Integra Nav2, `robot_localization`, herramientas para zonas de exclusión y un backend ROS para control manual y snapshots de navegación.

## Ejecutables reales
- `gazebo_utils`
- `zones_manager`
- `nav_command_server`
- `nav_snapshot_server`

Este checkout no incluye los antiguos nodos de waypoints interactivos, logger GUI ni teleop de teclado.

## Launches reales
- `ros2 launch navegacion_gps simulacion.launch.py`
  - Gazebo Sim + bridge ROS/GZ + robot_localization + Nav2 + zonas + backend web opcional
  - `realism_mode:=true` por defecto: reutiliza `nav2_only.launch.py`, desactiva ultrasounds en `collision_monitor` y emula la lógica del actuador real
  - Nuevo `gps_profile:=ideal|f9p_rtk|m8n`: si se pasa, tiene precedencia; si no, el launch legacy sigue mapeando `realism_mode:=false -> ideal` y `realism_mode:=true -> m8n`
  - `realism_mode:=false`: preserva el flujo legacy de simulación con passthrough directo de `/cmd_vel_final`
- `ros2 launch navegacion_gps real.launch.py`
  - robot_localization + Nav2 + backend de telemetría seleccionable (`mavros` por defecto, `pixhawk_driver` como fallback) + zonas + backend web opcional
- `ros2 launch navegacion_gps real_global_v2.launch.py`
  - bringup global real para la Raspberry: cadena real `v2` + `navsat_transform` + EKF global + Nav2 sobre `map`, con datum configurable por launch
- `ros2 launch navegacion_gps rviz_real.launch.py`
  - RViz + `robot_state_publisher` usando el URDF real
- `ros2 launch navegacion_gps rviz_real_global_v2.launch.py`
  - RViz global `v2` para correr en la PC local, apuntando al robot real y con `robot_state_publisher` local opcional

## Navegacion Local V2
La `v2` agrega una base nueva de navegacion local para el robot Ackermann, separada de la `v1` y sin depender de GPS en `odom -> base_footprint`.

Launches nuevos:

- `ros2 launch navegacion_gps sim_local_v2.launch.py`
- `ros2 launch navegacion_gps real_local_v2.launch.py`
- `ros2 launch navegacion_gps sim_global_v2.launch.py`
- `ros2 launch navegacion_gps real_global_v2.launch.py`

La `v2` usa:

- odometria Ackermann derivada de `DriveTelemetry`;
- EKF local en `odom`;
- Nav2 nativo sobre `odom` con planner, smoother y BT;
- keepout filter estatico compartido por `sim_local_v2` y `real_local_v2`;
- visualizacion de `/plan`, `/stop_zone`, `/keepout_filter_mask` y `/costmap_filter_info` en RViz.

Perfiles `v2` relevantes:

- `real_local_v2` mantiene navegacion local-only en `odom`.
- `sim_global_v2` y `real_global_v2` agregan la capa global `map -> odom` con `navsat_transform` + EKF global.
- `sim_local_v2` y `sim_global_v2` exponen `gps_profile:=ideal|f9p_rtk|m8n`; ambos arrancan en `ideal` por defecto.
- `real_global_v2` mueve goals LL y la web al frame `map`, y permite override del datum por launch con `datum_lat`, `datum_lon` y `datum_yaw_deg`.
- `rviz_real_global_v2` usa `rviz_global_v2.rviz` para visualizar ese stack desde la PC local.

Convencion fija operativa para `global v2`:

- por default el repo asume que el robot arranca mirando al Este
- `datum_yaw_deg` usa convencion ROS ENU, asi que `0.0` significa Este
- esto no representa un heading global medido; es solo una hipotesis operativa visible
- si el robot no arranca mirando al Este, hay que overridear `datum_yaw_deg`

Flag de launch util para diagnostico:

- `use_keepout:=True` por defecto en `sim_local_v2`, `real_local_v2` y `nav_local_v2`
- `use_keepout:=True` por defecto tambien en `sim_global_v2` y `real_global_v2`
- si se pasa `use_keepout:=False`, no se levantan los servidores keepout y los costmaps cargan una variante de params sin `keepout_filter`

Guia tecnica detallada:

- [LOCAL_NAV_V2.md](LOCAL_NAV_V2.md)
- [SIM_LOCAL_V2_FIDELITY.md](SIM_LOCAL_V2_FIDELITY.md)
- [REAL_LOCAL_V2_CHECKLIST.md](REAL_LOCAL_V2_CHECKLIST.md)
- [REAL_GLOBAL_V2_CHECKLIST.md](REAL_GLOBAL_V2_CHECKLIST.md)

## Flujo de control
- Nav2 publica `/cmd_vel`.
- `nav2_collision_monitor` publica `/cmd_vel_safe`.
- `nav_command_server` recibe `/cmd_vel_safe` y comandos manuales en `/cmd_vel_teleop`.
- `nav_command_server` publica `/cmd_vel_final` (`interfaces/msg/CmdVelFinal`).
- `controller_server` consume `/cmd_vel_final`.
- En `real_local_v2`, `controller_server` usa el backend UART real y publica `/controller/drive_telemetry`.
- En `sim_local_v2`, `controller_server` usa `transport_backend:=sim_gazebo`, publica `/cmd_vel_gazebo` hacia Gazebo y sintetiza `/controller/drive_telemetry` a partir de `/odom_raw` y `/joint_states`.

## Nodos del paquete
### `zones_manager`
- Gestiona zonas no transitables a partir de GeoJSON.
- Genera y recarga la máscara `keepout`.
- Servicios:
  - `/zones_manager/set_geojson`
  - `/zones_manager/get_state`
  - `/zones_manager/reload_from_disk`

### `nav_command_server`
- Backend ROS para órdenes geográficas y control manual.
- Publica telemetría en `/nav_command_server/telemetry`.
- Servicios:
  - `/nav_command_server/set_goal_ll`
  - `/nav_command_server/cancel_goal`
  - `/nav_command_server/brake`
  - `/nav_command_server/set_manual_mode`
  - `/nav_command_server/get_state`
- Acciones cliente:
  - `follow_waypoints`
  - `navigate_through_poses`

### `nav_snapshot_server`
- Compone snapshots PNG del estado local de navegación.
- Servicio:
  - `/nav_snapshot_server/get_nav_snapshot`

### `nav_observability`
- Publica diagnósticos ROS 2 agregados en `/diagnostics`.
- Resume salud de:
  - GPS
  - localización
  - flujo de comandos Nav2
  - `collision_monitor`
  - `nav_command_server`
  - `controller_server`
- Reutiliza `/nav_command_server/telemetry`, `/nav_command_server/events` y los JSON de `/controller/status` y `/controller/telemetry`.

### `gazebo_utils`
- Normaliza `frame_id` y tópicos de sensores bridged desde Gazebo Sim.
- Puede puentear `/cmd_vel_final` hacia `/cmd_vel_gazebo` en simulación.
- En `realism_mode:=true` desactiva el bridge de ultrasounds y usa una emulación de actuador alineada con el robot real.
- En la ruta legacy de simulación también aplica perfiles GPS explícitos y publica `/gps/rtk_status`.

### `sim_local_v2`
- Usa la misma cadena de mando ROS que `real_local_v2`:
  - `/cmd_vel_safe -> nav_command_server -> /cmd_vel_final -> vehicle_controller_server`
- Mantiene `sim_v2_base.launch.py` y `sim_sensor_normalizer_v2` para sensores/bridges.
- La telemetría de conducción para `ackermann_odometry` sale de `/controller/drive_telemetry`, igual que en el robot real.
- Expone `gps_profile:=ideal|f9p_rtk|m8n`; por defecto usa `ideal` para no ensuciar los diagnósticos de arquitectura.

## Observabilidad y debugging
- Telemetría de navegación:
  - `/nav_command_server/telemetry`
- Eventos discretos:
  - `/nav_command_server/events`
- Diagnósticos ROS 2:
  - `/diagnostics`
- Web de control:
  - `Active Alerts` muestra diagnósticos `WARN` y `ERROR` que llegan desde el backend
  - `Recent Events` muestra la secuencia reciente de decisiones y fallas publicada por navegación

Eventos de navegación relevantes:
- `GOAL_REQUESTED`
- `GOAL_ACCEPTED`
- `GOAL_REJECTED`
- `GOAL_CANCELLED`
- `GOAL_RESULT_SUCCEEDED`
- `GOAL_RESULT_ABORTED`
- `LOOP_RESTART_FAILED`
- `FROMLL_FAILED`
- `ACTION_SERVER_UNAVAILABLE`
- `MANUAL_TAKEOVER`
- `MANUAL_WATCHDOG_STOP`
- `COLLISION_STOP_ACTIVE`
- `BRAKE_APPLIED`

## Tópicos y frames principales
- Entradas de localización:
  - `/imu/data`
  - `/gps/fix`
  - `/odom`
- Contrato MAVROS nativo usado cuando `telemetry_backend:=mavros`:
  - `/global_position/raw/fix`
  - `/local_position/odom`
  - `/local_position/velocity_local`
  - `sensores/mavros_compat_bridge` repubica ese contrato hacia `/gps/fix`, `/odom` y `/velocity`
- Salidas de localización:
  - `/odometry/local`
  - `/odometry/gps`
- Percepción:
  - `/scan_3d`
  - `/scan`
- Control:
  - `/cmd_vel_safe` (`geometry_msgs/msg/Twist`)
  - `/cmd_vel_teleop` (`interfaces/msg/CmdVelFinal`)
  - `/cmd_vel_final` (`interfaces/msg/CmdVelFinal`)

Frames esperados:
- `map -> odom -> base_footprint`

## Dependencias funcionales
- Nav2:
  - `nav2_bringup`
  - `nav2_collision_monitor`
  - `nav2_map_server`
  - `nav2_lifecycle_manager`
- Localización:
  - `robot_localization`
- Simulación:
  - `ros_gz_sim`
  - `ros_gz_bridge`
- Costmaps:
  - `pointcloud_to_laserscan`

## Uso dentro del contenedor
Build:
```bash
./tools/compile-ros.sh navegacion_gps
```

Real:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps real.launch.py"
```

Real global `v2`:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps real_global_v2.launch.py"
```

Default visible de `global v2`:

- `datum_yaw_deg:=0.0`
- eso significa que el stack arranca asumiendo robot mirando al Este
- si el robot arranca en otra orientacion, hay que pasar `datum_yaw_deg:=...`

Real global `v2` con override de datum:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps real_global_v2.launch.py datum_lat:=<lat> datum_lon:=<lon> datum_yaw_deg:=<yaw_deg>"
```

RViz global `v2` en la PC local:
```bash
ros2 launch navegacion_gps rviz_real_global_v2.launch.py
```

RViz global `v2` en la PC local con `robot_state_publisher` local:
```bash
ros2 launch navegacion_gps rviz_real_global_v2.launch.py launch_robot_state_publisher:=true
```

Real con fallback al driver histórico:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps real.launch.py telemetry_backend:=pixhawk_driver"
```

Simulación:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps simulacion.launch.py"
```

Simulación legacy:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps simulacion.launch.py realism_mode:=false"
```

Perfiles de localización de simulación soportados:
- `sim_localization_profile:=baseline`
- `sim_localization_profile:=navsat_imu_heading`
- `sim_localization_profile:=decouple_global_yaw`
- `sim_localization_profile:=decouple_global_twist_only`
- `sim_localization_profile:=decouple_global_linear_twist_only`

Parámetros nuevos de la emulación del actuador en simulación:
- `sim_max_forward_mps`
- `sim_max_reverse_mps`
- `sim_max_abs_angular_z`

Perfiles principales del GPS simulado:
- `gps_profile:=ideal`
  - sin ruido ni bias walk; covarianza pequeña conocida; `/gps/rtk_status=SIM_IDEAL`
- `gps_profile:=f9p_rtk`
  - aproximación RTK fija tipo F9P; `/gps/rtk_status=RTK_FIXED`
- `gps_profile:=m8n`
  - GNSS degradado tipo NEO-M8N; `/gps/rtk_status=3D_FIX`

Benchmark de localización en simulación:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 run navegacion_gps sim_localization_benchmark --profile baseline --profile navsat_imu_heading --profile decouple_global_yaw --profile decouple_global_twist_only --profile decouple_global_linear_twist_only --realism-mode false --realism-mode true --output /tmp/sim_localization_matrix.json"
```

El benchmark está orientado a diagnóstico de deriva en reposo:
- exige runtime ROS limpio antes de arrancar;
- limpia el runtime al terminar;
- mide deriva de `map->odom`, consistencia `fromLL` vs `/odometry/gps`, covarianzas y una atribución simple del origen de la deriva;
- sólo corre goal tests opcionales si un perfil pasa el umbral de drift configurado.

RViz para real:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch navegacion_gps rviz_real.launch.py"
```

Rosbag manual de debugging:
```bash
./tools/record_nav_debug_bag.sh
```

Rosbag manual con perfil más amplio de Nav2:
```bash
./tools/record_nav_debug_bag.sh full_nav2
```

Replay mínimo:
```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 bag info /ros2_ws/bags/<bag_dir>"
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 bag play /ros2_ws/bags/<bag_dir> --clock"
```

Qué mirar primero cuando falla:
- `/diagnostics` para ver qué subsistema quedó en `WARN` o `ERROR`
- `/nav_command_server/events` para la secuencia de decisiones y fallas
- `/controller/status` y `/controller/telemetry` para `estop`, `failsafe` y fuente de control
- `/gps/fix`, `/odometry/local`, `/cmd_vel_safe` y `/cmd_vel_final` para reconstruir la cadena completa

## Estado actual de la simulación
Fixes de integración consolidados en esta branch:
- `fromLL` se transforma explícitamente a `map` antes de usarlo para goals y zonas.
- `collision_monitor` y la cadena de comandos quedan alineados con la limitación real hacia `/cmd_vel_final` y `/cmd_vel_gazebo`.
- `gazebo_utils` completa covarianzas razonables cuando Gazebo publica IMU o GPS con covarianzas nulas.
- `sim_localization_benchmark` deja una baseline reproducible para comparar perfiles sin contaminar el runtime.

Perfiles de localización evaluados:

| Perfil | Propósito | Estado | Última conclusión medida |
| --- | --- | --- | --- |
| `baseline` | Baseline reproducible y perfil por defecto | baseline | Sigue siendo la opción más segura para correr la simulación, pero en la validación final cerró con ~`7.16 m / 20 s` en `realism_mode:=false` y ~`6.04 m / 20 s` en `realism_mode:=true`. |
| `navsat_imu_heading` | Quitar `use_odometry_yaw` en `navsat_transform` | experimental | Puede mejorar algo en `realism_mode:=true` (~`3.57 m / 20 s`), pero no da una mejora consistente entre modos y sigue sin cumplir el criterio de cierre. |
| `decouple_global_yaw` | Sacar yaw absoluto del EKF global y de `navsat_transform` | experimental | Sirvió para aislar el problema, pero no quedó como candidato de uso: en la validación final quedó en ~`5.48 m / 20 s` legacy y ~`5.68 m / 20 s` realista. |
| `decouple_global_twist_only` | Dejar al EKF global sólo con `twist` de `/odometry/local` | experimental | Mejor perfil viable medido en `realism_mode:=true`: ~`3.48 m / 20 s`, con `diagnostics` todavía en `OK`, pero lejos del criterio de cierre. |
| `decouple_global_linear_twist_only` | Igual que el anterior, pero sin `vyaw` del EKF local | experimental | Dio el drift bruto más bajo en `realism_mode:=true` (~`2.17 m / 20 s`), pero `robot_localization` lo marca inválido por yaw no observado; no se recomienda como baseline operativa. |
| `gps_only_global` | Experimento interno para aislar GPS puro en el EKF global | descartado | No se expone por launch ni benchmark: rompió el bringup y no produjo muestras útiles. |

Conclusión operativa de esta branch:
- la deriva principal sigue naciendo en el fuse del `ekf_filter_node_map` con `/odometry/local`;
- `/odometry/gps` entra con covarianza fija (`0.1225 m^2` en `x/y`) pero su discrepancia real frente a `fromLL` suele ser bastante mayor, así que el EKF global sigue recibiendo una referencia demasiado optimista;
- la navegación global larga no queda resuelta en simulación;
- esta simulación sí sirve para probar integración, control local, conversión de goals LL y trayectos cortos, pero no valida patrullas largas ni navegación global outdoor.

## Notas
- `mapviz_gps.mvc` existe en la raíz del workspace y se copia en la imagen Docker, pero este paquete ya no expone un `mapviz.launch.py` dedicado.
- Si actualizas nombres de tópicos o frames, cambia también launches, YAML de Nav2 y YAML de `robot_localization`.
- El camino MAVROS no debe reintroducir `yaw_correction_deg`; cualquier ajuste de heading futuro debe hacerse desde configuración de localización y no en el bridge de compatibilidad.
- La simulación realista usa el mismo `nav2_only.launch.py` que la navegación real para acercar el runtime de Nav2, keepout y `collision_monitor`.

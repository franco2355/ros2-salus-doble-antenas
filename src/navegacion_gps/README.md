# navegacion_gps

Estado: actual
Alcance: resumen operativo del paquete y clasificación de perfiles
Fuente de verdad: `launch/`, `config/`, `setup.py` y tests del paquete

`navegacion_gps` integra navegación, localización, zonas de exclusión, observabilidad y el backend ROS que arbitra control automático y manual.

## Documentación del paquete
- Resumen de perfiles y launches: [docs/launch-matrix.md](/home/leo/codigo/ROS2_SALUS/docs/launch-matrix.md)
- Arquitectura runtime: [docs/runtime-architecture.md](/home/leo/codigo/ROS2_SALUS/docs/runtime-architecture.md)
- Navegación local V2:
  - [LOCAL_NAV_V2.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/LOCAL_NAV_V2.md)
  - [SIM_LOCAL_V2_FIDELITY.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/SIM_LOCAL_V2_FIDELITY.md)
  - [REAL_LOCAL_V2_CHECKLIST.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/REAL_LOCAL_V2_CHECKLIST.md)
- Navegación global V2:
  - [REAL_GLOBAL_V2_CHECKLIST.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/REAL_GLOBAL_V2_CHECKLIST.md)
- Benchmarks y observabilidad:
  - [docs/nav-benchmarks.md](/home/leo/codigo/ROS2_SALUS/docs/nav-benchmarks.md)
- Diseño y transición:
  - [IMPLEMENTATION_PLAN_GLOBAL_NAV_V2.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/IMPLEMENTATION_PLAN_GLOBAL_NAV_V2.md)
  - clasificación recomendada: histórico / transición

## Perfiles operativos
### Mainline actual
- `ros2 launch navegacion_gps simulacion.launch.py`
- `ros2 launch navegacion_gps real.launch.py`
- `ros2 launch navegacion_gps rviz_real.launch.py`

Este perfil mantiene la navegación principal del checkout y sigue siendo la referencia operativa general fuera de la familia V2.

### V2 local
- `ros2 launch navegacion_gps sim_local_v2.launch.py`
- `ros2 launch navegacion_gps real_local_v2.launch.py`
- `ros2 launch navegacion_gps rviz_real_local_v2.launch.py`

La V2 local usa odometría Ackermann derivada de `DriveTelemetry`, EKF local en `odom` y Nav2 local nativo sobre `odom`.

### V2 global
- `ros2 launch navegacion_gps sim_global_v2.launch.py`
- `ros2 launch navegacion_gps real_global_v2.launch.py`
- `ros2 launch navegacion_gps rviz_real_global_v2.launch.py`

La V2 global agrega la capa `map -> odom` sobre la base local Ackermann, con `navsat_transform`, EKF global, datum configurable y goals LL en `map`.
En los perfiles globales actuales, la corrección absoluta del EKF de `map` entra como `/gps/odometry_map` en frame `map` obtenido vía `fromLL`, y el heading global puede asistir al filtro mediante `/gps/course_heading`.

## Nodos propios más relevantes
- `zones_manager`
- `nav_command_server`
- `nav_snapshot_server`
- `nav_observability`
- `ackermann_odometry`
- `gazebo_utils`
- `sim_sensor_normalizer_v2`
- `gps_course_heading`

## Contratos públicos más usados
- Control:
  - `/cmd_vel_safe`
  - `/cmd_vel_teleop`
  - `/cmd_vel_final`
- Localización:
  - `/odometry/local`
  - `/odometry/gps`
  - `/gps/odometry_map`
  - `/odometry/global`
- Observabilidad:
  - `/nav_command_server/telemetry`
  - `/nav_command_server/events`
  - `/diagnostics`

## Helpers del workspace
- `./tools/launch_real_nav.sh`
- `./tools/launch_sim_local_v2.sh`
- `./tools/launch_real_local_v2.sh`
- `./tools/launch_sim_global_v2.sh`
- `./tools/launch_real_global_v2.sh`
- `./tools/record_nav_debug_bag.sh`
- `./tools/run_nav_benchmark.sh`
- `./tools/compare_nav_benchmarks.sh`

## Nota de uso
- Si buscás una guía operativa corta, usá este README y la matriz de launches.
- Si necesitás wiring fino o tuning de V2, usá los documentos específicos de V2.
- Si encontrás decisiones escritas en futuro o en tono de propuesta, tratarlas como documentación histórica, no como fuente de verdad del checkout actual.

# Matriz de Launches

Estado: actual
Alcance: clasificación operativa de launches y scripts helper
Fuente de verdad: `src/**/launch/*.launch.py` y `tools/*.sh`

## Mainline actual
| Perfil | Launch | Helper | Destino | Estado |
| --- | --- | --- | --- | --- |
| Simulación principal | `ros2 launch navegacion_gps simulacion.launch.py` | n/a | contenedor | actual |
| Navegación real principal | `ros2 launch navegacion_gps real.launch.py` | `./tools/launch_real_nav.sh` | robot/contenedor | actual |
| RViz real principal | `ros2 launch navegacion_gps rviz_real.launch.py` | `./tools/launch_real_rviz.sh` | PC local | actual |
| Pixhawk propio | `ros2 launch sensores pixhawk.launch.py` | n/a | robot/contenedor | actual |
| MAVROS | `ros2 launch sensores mavros.launch.py` | n/a | robot/contenedor | actual |
| RS16 | `ros2 launch sensores rs16.launch.py` | n/a | robot/contenedor | actual |
| Web editor / backend | `ros2 launch map_tools no_go_editor.launch.py` | `./tools/launch_no_go_editor.sh` | contenedor | actual |
| Controlador | `ros2 launch controller_server controller_server.launch.py` | `./tools/launch_controller.sh` | robot/contenedor | actual |

## V2 local
| Perfil | Launch | Helper | Destino | Estado |
| --- | --- | --- | --- | --- |
| Sim local Ackermann | `ros2 launch navegacion_gps sim_local_v2.launch.py` | `./tools/launch_sim_local_v2.sh` | contenedor | vigente |
| Real local Ackermann | `ros2 launch navegacion_gps real_local_v2.launch.py` | `./tools/launch_real_local_v2.sh` | robot/contenedor | vigente |
| RViz real local V2 | `ros2 launch navegacion_gps rviz_real_local_v2.launch.py` | `./tools/launch_real_local_v2_rviz.sh` | PC local | vigente |

## V2 global
| Perfil | Launch | Helper | Destino | Estado |
| --- | --- | --- | --- | --- |
| Sim global Ackermann | `ros2 launch navegacion_gps sim_global_v2.launch.py` | `./tools/launch_sim_global_v2.sh` | contenedor | vigente |
| Real global Ackermann | `ros2 launch navegacion_gps real_global_v2.launch.py` | `./tools/launch_real_global_v2.sh` | robot/contenedor | vigente |
| RViz real global V2 | `ros2 launch navegacion_gps rviz_real_global_v2.launch.py` | `./tools/launch_real_global_v2_rviz.sh` | PC local | vigente |

## Build y regeneracion
| Tarea | Comando | Nota |
| --- | --- | --- |
| Recompilar cambios de navegación/control | `./tools/compile-ros.sh controller_server navegacion_gps` | recompila dentro del contenedor |
| Abrir shell del contenedor | `./tools/exec.sh` | usar si hace falta correr `colcon` o `ros2` a mano |
| Lanzar `real_global_v2` | `./tools/launch_real_global_v2.sh` | wrapper corto sobre `ros2 launch navegacion_gps real_global_v2.launch.py` |
| Lanzar `real_global_v2` con datum explícito | `./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps real_global_v2.launch.py datum_lat:=<lat> datum_lon:=<lon> datum_yaw_deg:=<yaw_deg>"` | usar cuando el sitio operativo no coincide con el default |

## Nota sim vs real
- Los cambios en `sim_global_v2` que dependan de `joint_states` o `odom_raw` pertenecen a simulación y no pasan solos a `real_global_v2`.
- En `real_global_v2`, la fuente de steering que debe mantenerse estable es `/controller/drive_telemetry.steer_deg_measured`.
- Si el robot mide el ángulo en la barra central de dirección, ese dato es el que debe alimentar la odometría Ackermann real.
- En `sim_global_v2`, el gating del heading GPS ahora tiene knobs propios:
- `gps_course_heading_invalid_hold_s`
- `gps_course_heading_hold_yaw_variance_multiplier`

## Operación y diagnóstico
| Herramienta | Comando | Estado |
| --- | --- | --- |
| Rosbag debug navegación | `./tools/record_nav_debug_bag.sh` | vigente |
| Generador loop tipo cuadra | `./tools/generate_block_loop_benchmark.sh` | vigente |
| Healthcheck LiDAR | `./tools/healthcheck-lidar.sh` | vigente |
| Envío de path V2 | `./tools/send_follow_path_v2.sh` | soporte |
| Stop sim local V2 | `./tools/stop_sim_local_v2.sh` | soporte |
| Stop sim global V2 | `./tools/stop_sim_global_v2.sh` | soporte |
| Heading startup | `./tools/check_startup_heading.sh` | soporte |

## Criterio de uso
- Si el objetivo es operación estable del stack actual sin V2, usar el bloque `Mainline actual`.
- Si el objetivo es validación y tuning Ackermann sobre `DriveTelemetry`, usar `V2 local`.
- Si el objetivo es `map -> odom`, datum y goals LL sobre la base Ackermann, usar `V2 global`.
- Si un script helper y un launch discrepan, el launch es la fuente de verdad y el script debe considerarse conveniencia operativa.

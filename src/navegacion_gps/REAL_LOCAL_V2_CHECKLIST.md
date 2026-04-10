# Checklist de Validacion Antes de Usar `real_local_v2`

Estado: LEGACY / referencia tecnica. No usar como navegacion real operativa; usar `real_global_v2`.

## Preparacion
- Confirmar que no haya otra navegacion corriendo en el robot.
- Confirmar que Pixhawk, RS16 y controlador esten conectados.
- Confirmar acceso a `/dev/ttyACM0` y `/dev/serial0`.
- Confirmar que el robot tenga espacio libre para prueba.
- Para la primera validacion, preferir ruedas levantadas.
- Confirmar que el deploy en el robot corresponda al checkout actual que se quiere validar.

## Arranque Basico
Lanzar:

```bash
./tools/launch_real_local_v2.sh
```

Verificar que levanten:

- `mavros`
- `rs16`
- `vehicle_controller_server`
- `ackermann_odometry`
- `ekf_filter_node_local_v2`
- `keepout_filter_mask_server`
- `keepout_costmap_filter_info_server`
- `controller_server`
- `planner_server`
- `smoother_server`
- `bt_navigator`
- `behavior_server`
- `waypoint_follower`
- `collision_monitor`
- `nav_command_server`
- `stop_zone_republisher`

Verificar que RViz abra con la config local `v2`.

## Sensores y Topics
Confirmar mensajes validos en:

- `/controller/drive_telemetry`
- `/imu/data`
- `/scan_3d`
- `/scan`

En `/controller/drive_telemetry` verificar:

- velocidad valida
- steering valido
- timestamps frescos
- telemetria consistente con el estado del robot

## TF y Localizacion
Verificar TF:

- `odom -> base_footprint`
- `base_footprint -> base_link`
- `base_link -> imu_link`
- `base_link -> lidar_link`

Confirmar:

- `odom` queda fijo
- el robot se mueve respecto a `odom`

Verificar publicacion en:

- `/wheel/odometry`
- `/vehicle/twist`
- `/odometry/local`

## Signos y Sentido de Giro
Con ruedas levantadas:

- mandar un comando corto o un `2D Goal Pose` pequeno
- verificar que `angular.z > 0` produzca giro en el sentido esperado
- referencia validada en `salus`: con el robot visto desde atras, `angular.z > 0` debe intentar girar a la izquierda

Comparar:

- `/cmd_vel`
- `/cmd_vel_safe`
- `/cmd_vel_final`
- `/wheel/odometry`

Si el sentido no coincide, revisar:

- `invert_steer_from_cmd_vel`
- convencion de steering medida
- `invert_measured_steer_sign`
- signo de yaw en la odometria

## Cadena de Control
Verificar flujo:

- `bt_navigator -> planner_server -> smoother_server -> controller_server -> /cmd_vel -> /cmd_vel_safe -> /cmd_vel_final`

Confirmar:

- `collision_monitor` no frena por error al arrancar
- `nav_command_server` publica `/cmd_vel_final`
- `nav_command_server` esta en modo passthrough local para la `v2` (`forward_cmd_vel_safe_without_goal=true`)
- al terminar o cancelar un goal el robot queda en stop
- no hay residuos de comando luego del goal
- al validar telemetria, mirar varios mensajes seguidos: `drive_enabled` puede pasar a `true` antes de que `control_source` cambie a `PI`, y la velocidad medida puede tardar algunos ciclos mas en reflejar el movimiento

## Prueba Local Minima
Mandar un `2D Goal Pose` corto y simple.

Verificar en RViz:

- `Plan`
- `Stop Zone`
- traza del robot

## Prueba en Piso
Orden recomendado:

1. recta corta
2. curva suave
3. goal cruzado mas largo

Durante la prueba vigilar:

- oscilacion
- sobrepaso
- replan innecesario
- stops espurios
- perdida de seguimiento del path

## Parametros a Tener Listos Para Ajustar
- `wheelbase_m`
- `vx_min_effective_mps`
- covarianzas de `ackermann_odometry`
- footprint
- `lookahead_dist`
- `desired_linear_vel`
- `minimum_turning_radius`
- `xy_goal_tolerance`

## Criterio Minimo de Aceptacion
- steering con signo correcto
- `/wheel/odometry` coherente con el movimiento
- `/odometry/local` estable sin GPS
- `/cmd_vel_final` presente y coherente con `/cmd_vel_safe`
- `2D Goal Pose` corto ejecutado sin abortos raros
- stop correcto al terminar o cancelar
- keepout visible en RViz y topics `/keepout_filter_mask` y `/costmap_filter_info` presentes

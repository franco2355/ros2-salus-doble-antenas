# Sim Local V2

Estado: LEGACY / referencia tecnica. No usar como simulacion operativa vigente; usar `sim_global_v2`.

## Objetivo
`sim_local_v2` es el perfil de simulacion de la navegacion local `v2` para el robot Ackermann.

Su objetivo es ejecutar en Gazebo una version de la capa local que conserve la misma logica operativa que `real_local_v2` en:

- la cadena de mando;
- la telemetria de conduccion;
- la odometria Ackermann;
- la localizacion local en `odom`;
- la integracion con Nav2.

No busca modelar todos los efectos fisicos del robot real. La prioridad es que el flujo ROS y el contrato entre nodos sea lo mas parecido posible al perfil real.

## Launch principal

```bash
ros2 launch navegacion_gps sim_local_v2.launch.py
```

Script recomendado:

```bash
./tools/launch_sim_local_v2.sh
```

Script de cierre:

```bash
./tools/stop_sim_local_v2.sh
```

## Que levanta
`sim_local_v2` compone estos bloques principales:

1. `sim_v2_base.launch.py`
2. `sim_sensor_normalizer_v2`
3. `vehicle_controller_server`
4. `nav_command_server`
5. `localization_v2.launch.py`
6. `nav_local_v2.launch.py`
7. `rviz_local_v2.rviz`

## Funcion de cada bloque
### `sim_v2_base.launch.py`
Levanta la base de simulacion:

- Gazebo;
- bridges ROS/GZ;
- `robot_state_publisher`;
- spawn del robot;
- conversion de `/scan_3d` a `/scan`.

Tambien expone las señales simuladas que luego consume el resto del stack:

- `/odom_raw`
- `/joint_states`
- `/imu/data_raw`
- `/gps/fix_raw`
- `/scan_3d_raw`

### `sim_sensor_normalizer_v2`
Normaliza sensores bridged desde Gazebo para que el resto del stack vea interfaces consistentes con el entorno real.

En particular:

- ajusta `frame_id`;
- corrige covarianzas;
- republica IMU, GPS y nube en los topics esperados por la `v2`.

### `vehicle_controller_server`
En `sim_local_v2`, este nodo corre en modo:

```text
transport_backend=sim_gazebo
```

Su rol es equivalente al del controlador real, pero con backend de simulacion.

Consume:

- `/cmd_vel_final`
- `/odom_raw`
- `/joint_states`

Publica:

- `/cmd_vel_gazebo`
- `/controller/telemetry`
- `/controller/drive_telemetry`

### `nav_command_server`
Arbitra la salida de navegacion automatica con el control manual.

Consume:

- `/cmd_vel_safe`
- `/cmd_vel_teleop`

Publica:

- `/cmd_vel_final`
- `/nav_command_server/telemetry`
- `/nav_command_server/events`

### `localization_v2.launch.py`
Levanta la localizacion local Ackermann:

- `ackermann_odometry`
- EKF local (`robot_localization`)

Usa `/controller/drive_telemetry` como fuente de telemetria de movimiento, igual que en el perfil real.

### `nav_local_v2.launch.py`
Levanta la capa local de Nav2:

- `planner_server`
- `controller_server`
- `smoother_server`
- `bt_navigator`
- `behavior_server`
- `waypoint_follower`
- `collision_monitor`
- servidores y lifecycle managers asociados

## Cadena de mando
La cadena nominal de control en `sim_local_v2` es:

```text
bt_navigator / Nav2
-> planner_server
-> smoother_server
-> controller_server
-> /cmd_vel
-> collision_monitor
-> /cmd_vel_safe
-> nav_command_server
-> /cmd_vel_final
-> vehicle_controller_server
-> /cmd_vel_gazebo
-> Gazebo
```

Esto hace que la simulacion use el mismo punto de arbitraje y el mismo punto de actuacion logica que el robot real.

## Telemetria de conduccion
La telemetria de conduccion en `sim_local_v2` sale de `vehicle_controller_server`.

Topic principal:

- `/controller/drive_telemetry`

Ese topic es la entrada de `ackermann_odometry`, igual que en `real_local_v2`.

La telemetria incluye, entre otros campos:

- `ready`
- `fresh`
- `drive_enabled`
- `estop`
- `control_source`
- `speed_mps_measured`
- `steer_deg_measured`
- `brake_applied_pct`

## Como estima el movimiento en simulacion
El backend `sim_gazebo` del `vehicle_controller_server` sintetiza la telemetria usando el estado de Gazebo.

### Velocidad medida
Se deriva desde:

- `/odom_raw`

### Steering medido
Se deriva preferentemente desde:

- `/joint_states`

Eso permite que la odometria Ackermann consuma una medicion de steering consistente con la simulacion mecanica, en vez de depender de un helper externo paralelo.

## Localizacion local
La localizacion en `sim_local_v2` sigue la misma estructura de la `v2`:

1. `ackermann_odometry` consume `/controller/drive_telemetry`
2. publica `/wheel/odometry`
3. el EKF local fusiona `/wheel/odometry` y `/imu/data`
4. publica `/odometry/local`
5. publica TF `odom -> base_footprint`

El frame de trabajo sigue siendo:

```text
odom -> base_footprint
```

No hay `map -> odom` en esta fase.

## Topics principales
### Control
- `/cmd_vel`
- `/cmd_vel_safe`
- `/cmd_vel_teleop`
- `/cmd_vel_final`
- `/cmd_vel_gazebo`

### Telemetria y odometria
- `/controller/drive_telemetry`
- `/wheel/odometry`
- `/vehicle/twist`
- `/odometry/local`
- `/odom_raw`

### Sensores
- `/joint_states`
- `/imu/data`
- `/gps/fix`
- `/scan_3d`
- `/scan`

## Convenciones importantes
En `sim_local_v2` se usan estos defaults para alinearse con el perfil real:

- `invert_steer_from_cmd_vel=True`
- `invert_measured_steer_sign=True`

Eso ayuda a que la simulacion y el robot real compartan la misma convencion de giro en la cadena de mando y en la telemetria usada por la odometria.

## Convencion de signos de steering
### Idea general
La cadena local convive con mas de una convencion de signo:

- la convencion ROS de `cmd_vel.angular.z`;
- la convencion del actuador real;
- la convencion geometrica del modelo de Gazebo;
- la convencion de telemetria que consume `ackermann_odometry`.

Por eso aparecen inversiones de signo en distintos puntos. No representan el mismo ajuste repetido: cada una adapta una frontera distinta entre interfaces.

### Convencion operativa buscada
La meta de `sim_local_v2` es que el resto del stack vea el mismo convenio externo que en `real_local_v2`.

En particular:

- la navegacion publica `cmd_vel`;
- `vehicle_controller_server` traduce ese comando al convenio del actuador;
- la telemetria publicada en `/controller/drive_telemetry` mantiene el convenio que espera `ackermann_odometry`;
- `ackermann_odometry` aplica el mismo `invert_measured_steer_sign` que en el perfil real.

### Donde se adapta el signo en simulacion
#### 1. De `cmd_vel` a `steer_pct`
`controller_server_node` usa:

- `invert_steer_from_cmd_vel`

Eso adapta la convencion ROS de `angular.z` al convenio de steering usado por el controlador.

#### 2. De `steer_pct` a Gazebo
El backend `sim_gazebo` usa:

- `sim_invert_actuation_steer_sign`

Eso adapta el comando del controlador al signo fisico del modelo de Gazebo y de sus joints.

#### 3. De la medicion simulada a la telemetria expuesta
El backend `sim_gazebo` usa:

- `sim_invert_measured_steer_sign`

Eso hace que `/controller/drive_telemetry` exponga el steering con el mismo convenio esperado por el stack superior.

#### 4. De la telemetria a la odometria Ackermann
`ackermann_odometry` usa:

- `invert_measured_steer_sign`

Ese paso ya existia para el perfil real y se conserva tambien en simulacion para que ambos perfiles compartan el mismo contrato en la entrada de odometria.

### Interpretacion recomendada
Las inversiones de signo tienen sentido mientras se cumpla esto:

- cada inversion corrige una frontera distinta;
- el convenio visible para el resto del stack se mantiene estable;
- sim y real entregan una telemetria equivalente a `ackermann_odometry`.

Lo que se debe evitar es usar inversiones como parche local sin poder explicar que convención corrige cada una.

### Checklist de validacion de signo
Cada vez que se toque URDF, joints, Gazebo o el controlador, conviene validar:

1. con `linear.x > 0` y `angular.z > 0`, el vehiculo gira fisicamente al lado esperado en simulacion;
2. `/controller/drive_telemetry.steer_deg_measured` mantiene el mismo convenio que en el robot real;
3. `/wheel/odometry.angular.z` conserva el signo esperado para ese giro;
4. `sim_local_v2` y `real_local_v2` siguen usando los mismos defaults visibles:
   - `invert_steer_from_cmd_vel=True`
   - `invert_measured_steer_sign=True`

## Diferencias con `real_local_v2`
### Lo que es igual conceptualmente
`sim_local_v2` y `real_local_v2` comparten:

- `nav_command_server`
- `ackermann_odometry`
- EKF local
- `nav_local_v2.launch.py`
- `collision_monitor`
- keepout filter
- contrato de `/controller/drive_telemetry`
- arbitraje por `/cmd_vel_final`

### Lo que cambia
En `real_local_v2`:

- el controlador habla con el actuador real por UART;
- la telemetria proviene del controlador fisico;
- los sensores vienen de hardware real.

En `sim_local_v2`:

- el controlador usa `transport_backend=sim_gazebo`;
- la actuacion sale por `/cmd_vel_gazebo`;
- la telemetria se sintetiza desde `/odom_raw` y `/joint_states`;
- los sensores vienen bridged desde Gazebo y luego se normalizan.

### Limites de fidelidad
`sim_local_v2` no replica completamente:

- slip real;
- latencias fisicas complejas;
- ruido mecanico fino;
- no linealidades del actuador real;
- comportamiento electrico o fallas del hardware.

Su foco es la fidelidad del pipeline ROS y de la logica de navegacion local.

## Uso recomendado
Para correr la simulacion de forma limpia:

```bash
./tools/launch_sim_local_v2.sh
```

Para detenerla:

```bash
./tools/stop_sim_local_v2.sh
```

Eso evita dejar instancias viejas de Gazebo o bridges vivas entre corridas.

## Relacion con otros documentos
- [LOCAL_NAV_V2.md](LOCAL_NAV_V2.md): descripcion general de la navegacion local `v2`
- [REAL_LOCAL_V2_CHECKLIST.md](REAL_LOCAL_V2_CHECKLIST.md): checklist operativo del perfil real

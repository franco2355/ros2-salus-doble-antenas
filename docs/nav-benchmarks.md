# Benchmarks de Navegacion

Estado: actual
Alcance: benchmarks graduados para tuning de heading global y comparacion entre corridas
Fuente de verdad: `src/navegacion_gps/config/nav_benchmark_scenarios.yaml`, `nav_benchmark_runner`, `nav_benchmark_report`

## Objetivo

Estas herramientas sirven para medir si los cambios en localizacion o navegacion mejoran o empeoran:

- saltos del heading global (`map -> odom`, `map -> base`)
- error lateral durante goals simples
- tiempo de cierre y error final al goal
- validez del heading inferido por GPS

La idea es correr solo el perfil minimo necesario:

- `smoke`: si queres saber rapido si rompiste lo basico
- `heading_core`: perfil recomendado para este problema
- `regression_core`: antes de dar por bueno un cambio
- `full`: solo cuando el cambio ya paso los anteriores

## Escenarios incluidos

- `idle_heading_12s`: reposo para aislar saltos de heading sin movimiento
- `straight_short_6m`: recta corta, valida lo basico
- `straight_medium_12m`: recta media, muestra drift y saltos acumulados
- `turn_left_short`: curva suave izquierda
- `turn_right_short`: curva suave derecha
- `diagonal_far_left`: trayecto mas largo con carga sobre el estimador global
- `diagonal_far_right`: complemento del diagonal izquierdo
- `long_straight_25m`: stress test largo

## Uso

La stack ROS 2 debe estar ya levantada. Este tooling no hace `launch`.

Listar perfiles y escenarios:

```bash
./tools/run_nav_benchmark.sh heading_core --list
```

Correr el perfil recomendado para heading:

```bash
./tools/run_nav_benchmark.sh heading_core
```

Correr solo algunos escenarios:

```bash
./tools/run_nav_benchmark.sh heading_core --scenarios idle_heading_12s,straight_short_6m
```

Limitar por dificultad:

```bash
./tools/run_nav_benchmark.sh heading_core --max-difficulty 2
```

Comparar dos corridas:

```bash
./tools/compare_nav_benchmarks.sh \
  /ros2_ws/artifacts/nav_benchmarks/heading_core_base.json \
  /ros2_ws/artifacts/nav_benchmarks/heading_core_candidate.json
```

## Linea actual de tuning

Estado de trabajo sobre `sim_global_v2` al dia de hoy:

- el retune global del controlador Nav2 fue probado y revertido;
- no conviene seguir tocando RPP en forma global para este problema;
- la sospecha principal paso a la capa local/cinematica;
- el cambio activo se hizo en `controller_server/sim_gazebo_backend.py`, no en Nav2.

### Que se ajusto ahora

En simulacion:

- ya no se promedia bruto `front_left_steer_joint` y `front_right_steer_joint`;
- se reconstruye el angulo central Ackermann con `wheelbase` y `track_width`;
- si `joint_states` y `odom_raw` discrepan mas de `5 deg`, se usa la curvatura inferida por odometria;
- se propagaron esos parametros a `sim_local_v2` y `sim_global_v2`.

En esta fase no se modifico:

- `ackermann_odometry` del perfil real;
- la logica global de Nav2;
- la cadena UART del robot real.

### Lectura actual de resultados

Benchmarks relevantes corridos despues del parche:

- derecha: `artifacts/nav_benchmarks/heading_core_20260329_021123.json`
- izquierda: `artifacts/nav_benchmarks/heading_core_20260329_021621.json`

Conclusion operativa actual:

- la asimetria derecha/izquierda bajo fuerte en seguimiento y steer exigido;
- el problema principal ya no parece estar en la capa cinematica local;
- quedan saltos `map -> odom` en diagonales, que apuntan mas a la capa global que a la odometria Ackermann.

### Ajuste global actual

Despues del fix cinemático, el foco paso a `gps_course_heading` y al EKF global:

- se agrego una histéresis corta en `src/navegacion_gps/navegacion_gps/gps_course_heading_core.py`;
- cuando el heading por GPS pasa de `ok` a `steer_too_high` o `yaw_rate_too_high`, el ultimo yaw valido puede sostenerse por `0.8 s`;
- durante ese hold se publica con menor confianza usando `hold_yaw_variance_multiplier=4.0`;
- el setting quedo expuesto en `sim_global_v2.launch.py` como `gps_course_heading_invalid_hold_s`.

Benchmarks usados para decidirlo:

- baseline derecha: `artifacts/nav_benchmarks/heading_core_20260329_021123.json`
- candidato con hold `0.8 s`: `artifacts/nav_benchmarks/heading_core_20260329_024345.json`
- validacion `turn_right_short` con hold `0.8 s`: `artifacts/nav_benchmarks/heading_core_20260329_024529.json`
- experimento descartado con hold `0.5 s`: `artifacts/nav_benchmarks/heading_core_20260329_024646.json`

Lectura operativa:

- `diagonal_far_right` mejoro fuerte con hold `0.8 s`:
- `map_odom_jump_max_abs_deg` `17.64 -> 7.50`
- `map_odom_jump_count` `1 -> 0`
- `gps_course_heading.valid_ratio` `0.22 -> 0.40`
- `max_lateral_error_abs_m` `1.54 -> 1.09`
- `turn_right_short` con hold `0.8 s` no cruzo el umbral de salto global, pero quedo algo peor en error final y salto maximo;
- el experimento con hold `0.5 s` fue peor en conjunto, porque perdio parte de la mejora del diagonal y reintrodujo `map_odom` jump en el caso largo;
- por ahora el mejor compromiso encontrado es `gps_course_heading_invalid_hold_s=0.8`.

## Como interpretar sim vs real

El cambio actual sirve para simulacion porque `sim_gazebo_backend` si recibe:

- `/joint_states`
- `/odom_raw`

En el robot real no hace falta replicar ese mecanismo.

Para `real_global_v2`, la fuente correcta del steering sigue siendo:

- `DriveTelemetry.steer_deg_measured`

Ese dato idealmente debe venir del sensor real del actuador/barra de direccion.

En `salus`, como el sensor esta en el motor que mueve la barra central, la estrategia recomendada es:

- usar ese angulo central real como `steer_deg_measured`;
- mantener `ackermann_odometry` consumiendo ese dato;
- no introducir `joint_states` solo para parecerse a sim.

Si alguna vez faltara ese sensor, el fallback razonable para real seria estimar steer desde velocidad + `yaw_rate` independiente, pero eso todavia no es el camino principal del repo.

## Como generar el codigo para `real_global_v2`

### Donde cae cada tipo de cambio

Si el cambio es de simulacion pura:

- tocar `src/controller_server/controller_server/sim_gazebo_backend.py`
- tocar `src/navegacion_gps/launch/sim_local_v2.launch.py`
- tocar `src/navegacion_gps/launch/sim_global_v2.launch.py`

Si el cambio debe ir a navegacion real global:

- revisar `src/navegacion_gps/launch/real_global_v2.launch.py`
- revisar la cadena real de `controller_server`
- revisar quien llena `/controller/drive_telemetry`
- validar que `steer_deg_measured` siga representando el angulo central real

La regla importante es esta:

- un fix en `sim_gazebo_backend.py` no pasa automaticamente a `real_global_v2`;
- para real, el contrato publico es `DriveTelemetry`, no `joint_states`.

### Compilacion del codigo

Dentro del contenedor:

```bash
./tools/compile-ros.sh controller_server navegacion_gps
```

Si hace falta entrar manualmente:

```bash
./tools/exec.sh
source /opt/ros/humble/setup.bash
source /ros2_ws/install/setup.bash
colcon build --packages-select controller_server navegacion_gps --symlink-install
```

### Arranque de `real_global_v2`

Helper operativo:

```bash
./tools/launch_real_global_v2.sh
```

Arranque explicito:

```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps real_global_v2.launch.py"
```

Con datum explicito:

```bash
./tools/exec.sh "source /opt/ros/humble/setup.bash; source /ros2_ws/install/setup.bash; ros2 launch navegacion_gps real_global_v2.launch.py datum_lat:=<lat> datum_lon:=<lon> datum_yaw_deg:=<yaw_deg>"
```

Checklist recomendada antes de usarlo:

- `src/navegacion_gps/REAL_GLOBAL_V2_CHECKLIST.md`

## Salida

Cada corrida genera un JSON en `/ros2_ws/artifacts/nav_benchmarks/` con:

- metadata de la suite corrida
- resultado por escenario
- resumen de metricas clave
- `event_tail` para ver fallos o aborts recientes
- muestras crudas opcionales con `--keep-samples`

Metricas utiles para este problema:

- `map_odom_yaw.jumps.jump_count`
- `map_odom_yaw.jumps.max`
- `map_base_yaw.jumps.jump_count`
- `path_tracking.map_base_lateral_error_m.absolute.max`
- `outcome.final_goal_error_m`
- `gps_course_heading.valid_ratio`

## Rosbag de apoyo

`./tools/record_nav_debug_bag.sh` ahora incluye:

- `/odometry/global`
- `/controller/drive_telemetry`
- `/gps/course_heading/debug`

Eso permite correlacionar un benchmark fallido con el estado del heading y la telemetria del controlador.

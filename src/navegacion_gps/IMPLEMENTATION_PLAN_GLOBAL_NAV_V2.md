# Navegacion Global V2 Ackermann

## Resumen
La `Global Nav V2` agrega una capa global sobre la base local actual de la `v2`, sin tocar la `v1` legacy ni reemplazar la navegacion local en `odom`.

La idea central es mantener la capa local como verdad de control y sumar una capa global que corrija deriva y habilite goals geograficos:

```text
/global_position/raw/fix o su equivalente simulado
+ /imu/data
+ /odometry/local
-> navsat_transform
-> /odometry/gps
-> EKF global
-> map -> odom
```

Sobre esa base:

- la navegacion local sigue operando en `odom`;
- la navegacion global planifica en `map`;
- el control fino y la evitacion reactiva siguen apoyados en la `v2` local.

Esta documentacion define el diseño objetivo para una primera etapa enfocada en simulacion. No implementa codigo por si misma.

## Objetivo
Objetivo final de esta capa:

- poder enviar goals geograficos `LAT/LONG`;
- poder seguir usando `2D Goal Pose` en RViz, pero ahora en `map`;
- mantener desacoplada la base local Ackermann de la correccion global por GPS.

Esta `Global Nav V2` no reutiliza la `v1` como base. La `v1` queda intacta y fuera de esta propuesta.

## Alcance inicial
Primera fase documentada:

- simulacion primero;
- activacion por launch separado;
- goals LL y goals RViz en `map`;
- datum geodesico fijo y explicito;
- sin zonas georreferenciadas globales en `map` en esta etapa.

Queda fuera de esta fase:

- modificar `sim_local_v2`;
- modificar `real_local_v2`;
- reemplazar la capa local por la estimacion del FCU;
- migrar o tocar la `v1` legacy;
- implementar keepout global georreferenciado.

## Relacion con `LOCAL_NAV_V2`
La `LOCAL_NAV_V2` sigue siendo la base operativa del robot Ackermann:

- `ackermann_odometry` integra `DriveTelemetry`;
- el EKF local publica `/odometry/local` y `odom -> base_footprint`;
- Nav2 local controla el robot en `odom`;
- `collision_monitor` y `stop_zone` siguen protegiendo la capa reactiva.

La `Global Nav V2` no reemplaza nada de eso. Solo agrega una capa superior que:

- convierte GPS a una referencia util en `map`;
- estima `map -> odom`;
- permite goals globales sin mezclar GPS dentro del control local.

## Perfiles operativos
### `sim_local_v2`
Perfil actual, local-only:

- opera completamente en `odom`;
- no usa `map -> odom`;
- no depende de `navsat_transform`;
- sigue siendo la referencia para tuning local.

### `sim_global_v2`
Perfil nuevo propuesto:

- reutiliza la base local de `sim_local_v2`;
- agrega `navsat_transform`;
- agrega un EKF global;
- publica `map -> odom`;
- habilita goals LL y goals RViz en `map`.

Importante:

- `sim_global_v2` debe reutilizar la version actual de `sim_local_v2`, no el esquema legacy de simulacion;
- eso implica conservar la cadena de mando fiel introducida en `SIM_LOCAL_V2_FIDELITY.md`;
- en particular, la capa global debe montarse sobre:
  - `nav_command_server`
  - `vehicle_controller_server` con `transport_backend=sim_gazebo`
  - `/controller/drive_telemetry` como fuente de `ackermann_odometry`
- la estrategia elegida para construir `sim_global_v2` es crear un bringup base comun con `sim_local_v2`, y no incluir `sim_local_v2.launch.py` directamente.

La activacion propuesta para esta capa es mediante un launch separado:

```bash
ros2 launch navegacion_gps sim_global_v2.launch.py
```

Ese launch se define aqui como objetivo de arquitectura. La documentacion no implica que ya exista implementado.

### Estrategia de bringup elegida para simulacion
Para evitar acoplar la capa global al launch local actual, se elige esta estrategia:

1. crear un launch base comun para la `v2` de simulacion;
2. hacer que `sim_local_v2.launch.py` use ese launch base en modo local-only;
3. hacer que `sim_global_v2.launch.py` use ese launch base en modo global.

La opcion descartada es:

- incluir `sim_local_v2.launch.py` directamente desde `sim_global_v2.launch.py`.

Motivo principal:

- `sim_local_v2` ya no es un launch trivial;
- hoy fija parametros locales como `map_frame=odom` y `fromll_frame=odom`;
- si `sim_global_v2` dependiera directamente de ese launch, la separacion entre local y global quedaria difusa;
- un bringup base comun deja mas claro que partes son compartidas y que partes cambian entre perfiles.

### Reparto esperado de responsabilidades
#### Launch base comun de simulacion
Debe contener lo compartido por ambos perfiles:

- `sim_v2_base.launch.py`
- `sim_sensor_normalizer_v2`
- `vehicle_controller_server` en `sim_gazebo`
- `nav_command_server` parametrizable
- `localization_v2.launch.py`
- componentes comunes de la navegacion local

#### `sim_local_v2.launch.py`
Debe representar el perfil local-only:

- `map_frame=odom`
- `fromll_frame=odom`
- sin `navsat_transform`
- sin EKF global
- Nav2 operando localmente en `odom`

#### `sim_global_v2.launch.py`
Debe representar el perfil con capa global:

- `map_frame=map`
- `fromll_frame=map`
- con `navsat_transform`
- con EKF global
- Nav2 en modo global:
  - `global_frame=map`
  - `local_frame=odom`
  - `odom_topic=/odometry/local`

## Arquitectura general
### Capa local
La capa local se mantiene como en `LOCAL_NAV_V2.md`:

- entrada principal de movimiento: `DriveTelemetry`;
- entrada inercial: `/imu/data`;
- salida local: `/odometry/local`;
- TF local: `odom -> base_footprint`.

La capa local sigue siendo la fuente de verdad para:

- control Ackermann;
- seguimiento de path;
- reaccion a obstaculos;
- estabilidad de corto plazo aunque GPS degrade.

En simulacion, esta base local debe entenderse segun la version actualizada de `sim_local_v2`:

```text
/cmd_vel
-> /cmd_vel_safe
-> nav_command_server
-> /cmd_vel_final
-> vehicle_controller_server (sim_gazebo)
-> /cmd_vel_gazebo
-> Gazebo
-> /controller/drive_telemetry
-> ackermann_odometry
-> /odometry/local
```

La `Global Nav V2` debe apoyarse sobre esa cadena y no reintroducir:

- `cmd_vel_ackermann_bridge_v2` en el launch principal;
- `sim_drive_telemetry` en el launch principal.

### Capa global
La capa global agrega:

1. `navsat_transform`
2. `/odometry/gps`
3. EKF global
4. TF `map -> odom`

Rol de cada parte:

- `navsat_transform` toma GPS + orientacion + referencia local y genera una odometria georreferenciada consistente con el frame `map`;
- `/odometry/gps` aporta posicion global observada;
- el EKF global fusiona `/odometry/local` con `/odometry/gps`;
- el resultado estabiliza `map -> odom` sin contaminar la capa local de control.

## TF y frames
Arbol esperado con capa global activa:

```text
map
└── odom
    └── base_footprint
        └── base_link
```

### Que publica cada parte
- EKF local:
  - `/odometry/local`
  - `odom -> base_footprint`
- `navsat_transform`:
  - `/odometry/gps`
  - servicios de conversion geodesica tipo `fromLL`
- EKF global:
  - `map -> odom`

### Criterio de diseño
- `odom` sigue siendo continuo y apto para control;
- `map` representa la referencia global;
- la capa global puede corregir deriva de `odom`, pero no debe introducir saltos que rompan el control local.

## Fuentes de datos
### Contrato preferido para hardware real
La fuente GPS preferida para esta arquitectura es el contrato MAVROS nativo:

- `/global_position/raw/fix`
- `/imu/data`

La compatibilidad con `/gps/fix` se entiende como alias o puente de compatibilidad, no como fuente preferida del diseño.

### Contrato equivalente en simulacion
En simulacion, la capa global usa el equivalente simulado de GPS:

- `/gps/fix`
- `/imu/data`
- `/odometry/local`

La simulacion puede seguir publicando un GPS simplificado o degradado, pero la arquitectura global se mantiene igual.

## Flujo de navegacion
### Goal geografico LL

```text
goal LAT/LONG
-> fromLL
-> pose en map
-> planner_server
-> smoother_server
-> controller_server
-> /cmd_vel
-> collision_monitor
-> base local de actuacion
```

Notas:

- el goal LL debe convertirse a `map`, no a `odom`;
- la capa global existe justamente para que esa conversion tenga sentido estable;
- la ejecucion final sigue apoyandose en la base local.

### Goal RViz en `map`

```text
2D Goal Pose en RViz
-> bt_navigator
-> planner_server en map
-> smoother_server
-> controller_server sobre /odometry/local
-> /cmd_vel
-> collision_monitor
-> actuacion
```

La idea es que:

- el planner piense globalmente en `map`;
- el controlador siga conduciendo localmente en `odom`.

## `nav_command_server` en local y global
Para la `Global Nav V2` se elige mantener un unico `nav_command_server`.

No se propone:

- crear un nodo nuevo para global;
- sacar `nav_command_server` del pipeline local;
- duplicar la logica de arbitraje entre perfiles.

La estrategia elegida es usar el mismo nodo con dos presets de configuracion:

- preset local
- preset global

### Preset local
Perfil esperado para `sim_local_v2`:

- `map_frame=odom`
- `fromll_frame=odom`
- `gps_topic=/gps/fix`
- `forward_cmd_vel_safe_without_goal=True`

Interpretacion:

- el nodo sigue actuando como puente de mando y arbitraje;
- los services LL permanecen por compatibilidad;
- la operacion principal del perfil no depende de una capa global.

### Preset global
Perfil esperado para `sim_global_v2`:

- `map_frame=map`
- `fromll_frame=map`
- `gps_topic=/gps/fix`
- `forward_cmd_vel_safe_without_goal=True`

Interpretacion:

- el nodo mantiene la misma cadena de mando;
- los services LL pasan a estar alineados con la navegacion global real;
- la conversion LL debe caer en `map`, no en `odom`.

### Criterio de diseño elegido
Se elige esta estrategia porque:

- conserva la paridad entre simulacion local y simulacion global;
- mantiene la cadena ROS ya consolidada tras `SIM_LOCAL_V2_FIDELITY.md`;
- evita abrir una nueva variante de arbitraje;
- deja la diferencia local/global concentrada en la configuracion y en los frames, no en un nodo distinto.

## Nav2 en modo global
Con la capa global activa, la configuracion objetivo de Nav2 pasa a ser:

- `global_frame = map`
- `local_frame = odom`
- `odom_topic = /odometry/local`

Esto permite:

- planificacion global consistente con GPS;
- seguimiento local estable y desacoplado de la deriva o del ruido del GPS.

### Estrategia elegida para params de Nav2
Para `sim_global_v2` se elige usar un archivo de params propio de Nav2.

No se propone:

- parchear `nav2_local_v2_params.yaml` con overrides ad hoc;
- mezclar el perfil local y el perfil global dentro del mismo archivo principal;
- introducir todavia una jerarquia mas compleja de base comun + overlays.

La opcion elegida es mantener dos perfiles explicitos:

- `nav2_local_v2_params.yaml`
- `nav2_global_v2_params.yaml`

### Criterio de diseño
La razon principal es de mantenibilidad:

- `sim_local_v2` y `sim_global_v2` ya fueron definidos como perfiles separados;
- conviene que Nav2 refleje esa separacion de forma directa;
- el perfil local debe seguir siendo facil de leer y tunear sin contaminarse con decisiones globales;
- el perfil global debe poder evolucionar sin introducir regresiones en el local.

### Intencion del perfil global
`nav2_global_v2_params.yaml` debera expresar de forma explicita que:

- `bt_navigator` opera con `global_frame=map`;
- `behavior_server` usa `global_frame=map` y `local_frame=odom`;
- el planner global trabaja en `map`;
- el controlador local sigue usando `odom`;
- `odom_topic` sigue siendo `/odometry/local`.

## Localizacion global
### `navsat_transform`
Rol esperado:

- consumir GPS;
- consumir orientacion / referencia de yaw via IMU y odometria local;
- emitir `/odometry/gps`;
- sostener conversiones geograficas coherentes con `map`.

La base conceptual queda asi:

```text
GPS + IMU + /odometry/local -> navsat_transform -> /odometry/gps
```

### EKF global
Rol esperado:

- consumir `/odometry/local`;
- consumir `/odometry/gps`;
- publicar `map -> odom`.

La capa global no debe desplazar la capa local. Debe solo corregir la referencia global acumulada.

## Datum geodesico
Para esta primera version se fija un datum:

- estable;
- explicito;
- reproducible entre corridas de simulacion.

Default elegido para la documentacion:

- reutilizar el datum fijo ya presente en `dual_ekf_navsat_params.yaml`.

Esto se elige para:

- repetir pruebas;
- mantener consistente la conversion `LL -> map`;
- evitar que el origen cambie en cada arranque.

La estrategia de datum por mundo o por launch puede venir despues, pero no es el default de esta fase.

### Criterio para una futura `real_global_v2`
Para robot real, la recomendacion cambia levemente:

- el datum debe seguir siendo explicito;
- no conviene autodetectarlo en cada arranque;
- pero si conviene que sea configurable por deploy, launch o mapa operativo.

En otras palabras:

- en simulacion, datum fijo en config es suficiente y deseable;
- en real, el criterio recomendado es `datum fijo por escenario`, pero configurable.

Motivo:

- la conversion `LAT/LONG -> map` debe ser repetible entre sesiones;
- si el datum cambia solo por reiniciar, los goals LL dejan de caer en el mismo mapa;
- si el robot opera en mas de un predio o mapa, hace falta poder cambiar el datum sin reescribir la arquitectura.

Por eso, para una futura implementacion real, el comportamiento preferido seria:

1. datum explicito;
2. valor default guardado en configuracion;
3. override por launch o perfil de despliegue;
4. nunca inferido implicitamente desde el primer fix del dia.

### Criterio de usabilidad
Ese datum configurable no deberia exponerse como un concepto operativo para el usuario final.

La interfaz recomendada para una futura `real_global_v2` es:

- el usuario elige un `mapa`, `predio` o `perfil operativo`;
- el sistema carga internamente:
  - datum;
  - origen del mapa;
  - parametros asociados a esa zona de operacion.

En este modelo:

- el datum sigue existiendo como dato tecnico;
- pero queda encapsulado dentro de la configuracion del sitio;
- el operador no necesita entender que es un datum para usar goals LL.

Por eso, para implementacion real, la recomendacion de producto es:

- no pedirle al usuario que escriba o ajuste el datum manualmente;
- si permitir seleccion de sitio o mapa;
- y resolver el datum por configuracion interna de ese sitio.

### Precision esperada del datum
El datum no necesita coincidir exactamente con la posicion fisica del robot al momento de arrancar.

No es requisito que:

- el origen del `map` quede debajo del robot al iniciar;
- el robot arranque en `(0, 0)` de `map`;
- el datum represente la posicion instantanea del primer fix.

Lo que si importa es que el datum sea:

- consistente con el mapa usado;
- estable entre sesiones;
- suficientemente razonable para que la conversion `LAT/LONG -> map` caiga en la zona correcta de trabajo.

En la practica:

- el EKF global y `navsat_transform` ajustan la relacion entre `map`, `odom` y la observacion GPS;
- el robot puede arrancar en cualquier pose dentro del mapa;
- lo importante no es que el datum sea "perfecto", sino que no cambie arbitrariamente y no desplace el mapa de forma incoherente.

## Keepout y zonas
### Lo que se mantiene en esta fase
Se mantiene la proteccion reactiva local:

- `collision_monitor`
- `stop_zone`

Esa proteccion sigue siendo responsabilidad de la capa local.

### Lo que no entra todavia
No se define en esta fase:

- keepout georreferenciado en `map`;
- no-go zones globales basadas en LL;
- fusion completa entre zonas globales y la mascara local de keepout.

Si en una futura implementacion la navegacion global necesita un costmap global sin `keepout_filter`, eso debe quedar separado del comportamiento actual de `sim_local_v2` para no mezclar ambos perfiles.

### Decision actual para `sim_global_v2`
Para la primera fase de `sim_global_v2` se elige no incluir `keepout_filter` global.

Objetivo de esta decision:

- arrancar con la arquitectura global minima;
- probar `map -> odom`;
- probar goals LL y goals RViz en `map`;
- validar planner global + controlador local antes de sumar restricciones geograficas mas complejas.

Esto no significa descartar zonas no-go a futuro.

La intencion explicitamente aceptada es:

- en una fase posterior, agregar zonas no-go globales georreferenciadas;
- integrarlas al planner global en `map`;
- resolver entonces como conviven con la proteccion reactiva local.

## Pendientes de definicion
### Todavia no cerrados para `sim_global_v2`
La arquitectura de simulacion queda cerrada a nivel de diseño.

Nombres recomendados para la futura implementacion:

- `launch/sim_global_v2.launch.py`
- `launch/sim_nav_v2_base.launch.py`
- `config/nav2_global_v2_params.yaml`
- `config/rviz_global_v2.rviz`

Con esto, ya no quedan pendientes arquitectonicos relevantes para simulacion dentro de este documento.

## Estrategia de GPS simulado
Para `sim_global_v2` se elige trabajar con perfiles de GPS diferenciados.

La idea es validar la arquitectura global en mas de un escenario y no depender de una unica simulacion "perfecta".

### Perfiles elegidos
- `ideal`
- `m8n`
- `f9p_rtk`

### Perfil `ideal`
Objetivo:

- validar arquitectura, TF y conversiones sin que el ruido del GPS ensucie el diagnostico.

Interpretacion:

- GPS casi ideal;
- frecuencia estable;
- ruido despreciable o muy bajo;
- sin degradacion relevante.

Uso esperado:

- primer smoke test de `sim_global_v2`;
- validacion inicial de `map -> odom`;
- validacion inicial de goals LL y goals RViz en `map`.

### Perfil `m8n`
Objetivo:

- representar un GPS comun de calidad media, mas cercano a una operacion sin RTK.

Interpretacion:

- ruido horizontal apreciable;
- precision inferior a RTK;
- posible deriva lenta;
- comportamiento suficiente para poner a prueba la robustez de la capa global.

Uso esperado:

- pruebas de robustez intermedia;
- validacion de planner global con posicion menos estable;
- observacion de como se comporta `map -> odom` con una fuente GNSS mas realista y menos precisa.

### Perfil `f9p_rtk`
Objetivo:

- aproximar el comportamiento esperado del hardware real objetivo.

Interpretacion:

- GPS de alta calidad;
- ruido bastante menor que `m8n`;
- comportamiento cercano a un receptor RTK tipo F9P;
- sigue siendo simulacion, pero alineada con el sensor que se piensa usar en robot real.

Uso esperado:

- pruebas finales de simulacion antes de pasar a `real_global_v2`;
- validacion de la arquitectura global en un escenario parecido al hardware objetivo;
- comparacion entre operacion "ideal", GNSS comun y GNSS RTK.

### Criterio de validacion elegido
La progresion recomendada de pruebas para `sim_global_v2` queda asi:

1. `ideal`
2. `m8n`
3. `f9p_rtk`

Eso permite:

- primero validar arquitectura;
- despues validar robustez;
- y finalmente aproximarse al comportamiento esperado del hardware real.

## RViz para `sim_global_v2`
Para `sim_global_v2` se elige un RViz propio y separado del perfil local.

La idea es no reutilizar directamente el RViz de `sim_local_v2`, porque la operacion global cambia el frame mental de trabajo:

- en local, el foco esta en `odom`;
- en global, el foco pasa a `map`.

### Decision elegida
La configuracion objetivo es un RViz dedicado, por ejemplo:

- `rviz_global_v2.rviz`

### Criterio de diseño
Se elige esta estrategia porque:

- `sim_local_v2` y `sim_global_v2` ya estan definidos como perfiles distintos;
- conviene que la visualizacion tambien refleje esa separacion;
- el debug de `map -> odom` necesita elementos que no son centrales en el perfil local;
- se evita mezclar supuestos del RViz local o del RViz legacy.

### Intencion del RViz global
El RViz global debera estar pensado para:

- `Fixed Frame = map`
- visualizar `map -> odom -> base_footprint`
- enviar `2D Goal Pose` en `map`
- mostrar `/plan`
- mostrar `/odometry/local`
- mostrar `/odometry/gps`
- mostrar costmaps y elementos utiles para diagnostico global

La forma exacta del archivo RViz puede definirse mas adelante, pero la decision de tener uno propio ya queda cerrada.

## Interfaz publica del launch `sim_global_v2`
Para `sim_global_v2` se recomienda una interfaz publica chica y orientada a operacion.

La idea es que el launch exponga solo los parametros utiles para uso y testing, y no toda la parametrizacion interna del bringup.

### Argumentos publicos recomendados
- `use_sim_time`
- `use_rviz`
- `rviz_config`
- `gps_profile`
- `world`
- `nav_start_delay_s`

### Argumentos que no conviene exponer como API principal
Quedan como detalle interno del perfil:

- `map_frame`
- `fromll_frame`
- `nav2_params_file`
- `localization_params_file`
- paths internos de configuracion
- detalles del EKF global
- detalles internos del bringup base

### Criterio de diseño
Se elige esta interfaz porque:

- mantiene el launch simple de usar;
- evita que el perfil global se transforme en una caja de parametros dificil de operar;
- conserva la idea de perfil cerrado y reproducible;
- deja accesibles solo las variables utiles para simulacion y validacion.

### Ejemplo conceptual de uso
```bash
ros2 launch navegacion_gps sim_global_v2.launch.py gps_profile:=f9p_rtk use_rviz:=true
```

La idea no es exponer al usuario final toda la parametrizacion interna de frames, EKFs y wiring, sino entregarle un perfil global claro y controlado.

## Pruebas automaticas minimas para `sim_global_v2`
Para la primera fase se recomiendan pruebas automaticas minimas, estructurales y baratas de ejecutar.

La idea no es arrancar con tests end-to-end completos de navegacion, sino validar primero que el bringup global queda bien cableado y no rompe las decisiones de arquitectura ya cerradas.

### Alcance recomendado de la fase 1
Las pruebas automaticas deberian cubrir:

- composicion del launch;
- parametros clave del perfil global;
- exclusion de componentes no deseados en esta fase;
- aceptacion de perfiles GPS definidos.

### Casos recomendados
#### 1. Test de composicion del launch
Verificar que `sim_global_v2.launch.py`:

- existe;
- usa el bringup base comun elegido;
- levanta `navsat_transform`;
- levanta EKF global;
- carga el params file global de Nav2;
- usa el RViz global.

#### 2. Test de configuracion global de `nav_command_server`
Verificar que el preset global deja configurado:

- `map_frame=map`
- `fromll_frame=map`
- `forward_cmd_vel_safe_without_goal=True`

#### 3. Test de configuracion global de Nav2
Verificar que el perfil global use:

- `global_frame=map`
- `local_frame=odom`
- `odom_topic=/odometry/local`

#### 4. Test de exclusion de componentes fuera de fase
Verificar que en esta primera fase:

- no se habilita `keepout_filter` global;
- no se reintroducen helpers legacy en la cadena principal;
- no se rompe la base local ya alineada con `SIM_LOCAL_V2_FIDELITY.md`.

#### 5. Test de perfiles GPS
Verificar que el launch acepte y enrute correctamente los perfiles:

- `ideal`
- `m8n`
- `f9p_rtk`

### Lo que no se exige en esta fase
No se considera obligatorio todavia:

- test end-to-end completo de mision;
- validacion automatica de error metrico sobre el mapa;
- pruebas largas de navegacion realista en Gazebo;
- benchmarks automaticos del planner global.

### Criterio de diseño
Se elige esta estrategia porque:

- protege la arquitectura sin meter fragilidad innecesaria;
- permite detectar rapido errores de wiring y configuracion;
- deja los tests pesados para una fase posterior, cuando `sim_global_v2` ya este estable.

### Todavia no cerrados para `real_global_v2`
Para robot real faltan mas decisiones que en simulacion:

- como se seleccionara el `sitio`, `mapa` o `perfil operativo`;
- donde vivira esa configuracion por sitio;
- como se asociaran datum, mapa y parametros geograficos a cada sitio;
- si la seleccion del sitio se hara por launch, por archivo de deploy o por interfaz web;
- como se inicializara la mision LL desde la interfaz de operador;
- si el keepout global georreferenciado aparecera en una segunda fase o se mantendra solo la proteccion reactiva local;
- como se validara en piso la coherencia entre `map`, `odom`, GPS y goals LL;
- que estrategia se seguira ante GPS degradado, fix pobre o perdida temporal del GPS durante una mision.

Lista resumida de pendientes para robot real:

- definir el modelo operativo de `sitio` o `mapa`;
- decidir donde vive la configuracion geodesica por sitio;
- decidir como se selecciona el sitio en runtime o despliegue;
- definir como se expone la carga del sitio al operador;
- definir la fuente exacta de goals LL en operacion real;
- definir manejo de GPS degradado o sin fix confiable;
- decidir si habra fallback automatico a modo local-only;
- definir cuando y como incorporar keepout global georreferenciado;
- definir procedimiento de calibracion y validacion inicial en campo;
- definir criterios minimos de aceptacion para pasar de simulacion a robot real.

### Punto importante
Lo esencial ya esta decidido:

- la `v1` no se toca;
- la base local `v2` sigue siendo la fuente de verdad para control;
- la capa global corrige `map -> odom`;
- los goals globales caen en `map`;
- la simulacion usa datum fijo;
- la version real usara datum explicito encapsulado por sitio o mapa.

Lo que queda abierto son decisiones de implementacion, operacion y UX, no el principio de funcionamiento de la arquitectura.

## Contratos publicos esperados
Con `sim_global_v2` activo, los contratos relevantes pasan a ser:

- `/global_position/raw/fix` o equivalente simulado
- `/imu/data`
- `/odometry/local`
- `/odometry/gps`
- `/plan`
- `/cmd_vel`
- `/cmd_vel_safe`
- `map -> odom`
- `odom -> base_footprint`

Para goals LL tambien se espera una conversion estable:

- `fromLL`

## Estrategia de activacion
La activacion de la capa global se plantea por launch separado:

- `sim_local_v2.launch.py`: permanece local-only
- `sim_global_v2.launch.py`: agrega la capa global

Motivo:

- separar claramente los perfiles;
- permitir encender y apagar la capa global sin ensuciar la base local;
- evitar acoplar esta arquitectura a la `v1`.

## Validacion esperada en simulacion
### Escenarios minimos
1. Arrancar `sim_local_v2` sin capa global.
   Debe conservar el comportamiento actual.

2. Arrancar `sim_global_v2`.
   Debe existir:
   - `map -> odom`
   - `odom -> base_footprint`

3. Enviar un `2D Goal Pose` en RViz sobre `map`.
   Debe:
   - generarse un plan global valido;
   - ejecutarse el control sobre la base local;
   - mantenerse la cadena reactiva via `collision_monitor`.

4. Enviar un goal LL.
   Debe:
   - convertirse a pose en `map`;
   - producir navegacion coherente sin pasar por la `v1`.

5. Degradar o perder GPS en simulacion.
   Debe quedar claro que:
   - la capa global pierde calidad o queda menos confiable;
   - la base local sigue sosteniendo el control de corto plazo.

6. Verificar separacion funcional.
   Debe cumplirse que:
   - apagar la capa global no rompe la local;
   - activar la global no reintroduce dependencias de la `v1`.

## Riesgos conocidos
- datum incorrecto o inconsistente;
- saltos en `map -> odom`;
- desacople entre plan global y seguimiento local;
- confusion entre `/global_position/raw/fix` y `/gps/fix`;
- mezclar responsabilidades entre la `v1`, la `Local Nav V2` y esta capa global;
- pretender que la capa global reemplace la estabilidad de la capa local.

## Comparacion rapida
| Perfil | Frame principal de planificacion | Fuente principal de control | GPS en control local | Estado |
| --- | --- | --- | --- | --- |
| `v1` legacy | `map` | stack legacy | si, segun perfil legacy | mantener intacta |
| `Local Nav V2` | `odom` | base Ackermann local | no | actual |
| `Global Nav V2` | `map` | base local `v2` | no directo; solo como correccion global | diseño objetivo |

## Criterio de diseño final
La `Global Nav V2` debe entenderse como:

- una extension de la `v2` local;
- no una resurreccion de la `v1`;
- no un reemplazo de la odometria Ackermann;
- no una dependencia directa de la estimacion local del FCU.

La capa local sigue conduciendo. La capa global solo ubica globalmente al robot y habilita navegacion por `LAT/LONG` o por goals en `map`.

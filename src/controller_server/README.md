# controller_server

Paquete ROS 2 para el puente entre el backend de navegación y el protocolo UART v2 del actuador.

## Ejecutable real
- `controller_server_node`

## Entrada y salida
### Suscripción
- `/cmd_vel_final` (`interfaces/msg/CmdVelFinal`)

`controller_server` no consume `/cmd_vel_safe` directamente. Ese tópico existe aguas arriba y es arbitrado por `navegacion_gps/nav_command_server`.

### Publicaciones
- `/controller/status` (`std_msgs/msg/String`, payload JSON)
- `/controller/telemetry` (`std_msgs/msg/String`, payload JSON)

## Flujo
- `nav_command_server` publica `/cmd_vel_final`.
- `controller_server_node` traduce `CmdVelFinal` a comandos UART periódicos.
- La telemetría de retorno se reexpone como JSON para monitoreo y debugging.

## Parámetros principales
- `serial_port` (default `/dev/serial0`)
- `serial_baud` (default `115200`)
- `serial_tx_hz` (default `50.0`)
- `max_speed_mps`
- `max_reverse_mps`
- `control_hz`
- `telemetry_pub_hz`
- `auto_timeout_s`
- `max_abs_angular_z`
- `vx_deadband_mps`
- `vx_min_effective_mps`
- `reverse_brake_pct`
- `invert_steer_from_cmd_vel`
- `auto_drive_enabled`
- `estop_brake_pct`

## Launch
```bash
ros2 launch controller_server controller_server.launch.py
```

Con helpers del workspace:
```bash
./tools/launch_controller.sh
```

## Publicar un comando manual de prueba
```bash
ros2 topic pub --once /cmd_vel_final interfaces/msg/CmdVelFinal \
"{twist: {linear: {x: 0.4, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.1}}, brake_pct: 0}"
```

## Validación
Tests de lógica:
```bash
python3 -m pytest -q src/controller_server/test/test_control_logic.py
```

Dentro del contenedor:
```bash
./tools/compile-ros.sh controller_server
./tools/exec.sh "source /opt/ros/humble/setup.bash && source /ros2_ws/install/setup.bash && ros2 launch controller_server controller_server.launch.py --show-args"
```

## Nota sobre el módulo UART
La implementación de protocolo y transporte vive en `controller_server/rpy_esp32_comms/`.
Ese código conserva tests y utilidades propias del protocolo UART v2. No es un sustituto del nodo ROS; es la librería usada por el nodo.

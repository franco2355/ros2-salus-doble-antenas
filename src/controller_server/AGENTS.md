# AGENTS.md - controller_server

## Objetivo del paquete
`controller_server` es el puente ROS 2 entre `/cmd_vel_final` y el protocolo UART v2 del actuador.

## Estado real
- Paquete `ament_python` con ejecutable activo:
  - `controller_server_node`
- Librería UART activa:
  - `controller_server/rpy_esp32_comms/*.py`
- Tests activos:
  - `test/test_control_logic.py`
  - `controller_server/controller/tests/`

## Contrato operativo
- Entrada ROS:
  - `/cmd_vel_final` (`interfaces/msg/CmdVelFinal`)
- Salidas ROS:
  - `/controller/status`
  - `/controller/telemetry`
- No documentar ni asumir consumo directo de `/cmd_vel_safe` en este paquete.

## Invariantes de seguridad
- `CommsClient.start()` resetea el estado deseado a seguro.
- `CommsClient.stop()` envía varios frames seguros antes de cerrar UART.
- TX Pi -> actuador es periódico; no convertirlo en envíos event-driven solamente.

## Reglas de edición
- Si cambias el frame UART o semántica del protocolo, actualiza en el mismo cambio:
  - `rpy_esp32_comms/protocol.py`
  - tests del protocolo
  - README/documentación asociada
- No tocar el contrato `/cmd_vel_final` sin revisar `navegacion_gps/nav_command_server.py`.
- Evitar cambios de concurrencia sin tests.

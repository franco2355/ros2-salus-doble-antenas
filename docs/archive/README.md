# Archivo e Históricos

Estado: actual
Alcance: clasificar documentos históricos, de transición y third-party sin usarlos como fuente de verdad operativa
Fuente de verdad: documentación vigente listada en [docs/INDEX.md](/home/leo/codigo/ROS2_SALUS/docs/INDEX.md)

## Diseño y transición
- [src/navegacion_gps/IMPLEMENTATION_PLAN_GLOBAL_NAV_V2.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/IMPLEMENTATION_PLAN_GLOBAL_NAV_V2.md)
  - Estado recomendado: histórico de diseño / transición.
  - Motivo: describe decisiones arquitectónicas y contexto de implementación, pero no debe leerse como guía operativa principal del checkout actual.

## Documentación V2 profunda
- [src/navegacion_gps/LOCAL_NAV_V2.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/LOCAL_NAV_V2.md)
- [src/navegacion_gps/SIM_LOCAL_V2_FIDELITY.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/SIM_LOCAL_V2_FIDELITY.md)
- [src/navegacion_gps/REAL_LOCAL_V2_CHECKLIST.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/REAL_LOCAL_V2_CHECKLIST.md)
- [src/navegacion_gps/REAL_GLOBAL_V2_CHECKLIST.md](/home/leo/codigo/ROS2_SALUS/src/navegacion_gps/REAL_GLOBAL_V2_CHECKLIST.md)
  - Estado recomendado: vigente, pero especializada.
  - Motivo: son documentos de uso técnico profundo; no son puerta de entrada del repo.

## Documentación específica del controlador UART
- [src/controller_server/controller_server/controller/README.md](/home/leo/codigo/ROS2_SALUS/src/controller_server/controller_server/controller/README.md)
- [src/controller_server/controller_server/controller/COMUNICACIONES_UART_V2.md](/home/leo/codigo/ROS2_SALUS/src/controller_server/controller_server/controller/COMUNICACIONES_UART_V2.md)
  - Estado recomendado: específica del entorno Raspberry / stack UART.
  - Motivo: documentan el cliente y protocolo usados por el controlador, con referencias operativas propias del deployment en Raspberry.

## Third-party vendorizado
- [docs/upstream-sources.yaml](/home/leo/codigo/ROS2_SALUS/docs/upstream-sources.yaml)
- [src/rslidar_msg/README.md](/home/leo/codigo/ROS2_SALUS/src/rslidar_msg/README.md)
- [src/rslidar_sdk/README.md](/home/leo/codigo/ROS2_SALUS/src/rslidar_sdk/README.md)
  - Estado recomendado: referencia upstream.
  - Motivo: sirven para contexto del vendor, no para describir el wiring propio de SALUS.

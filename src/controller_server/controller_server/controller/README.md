# RAPY_ESP32_COMMS

Cliente UART v2 para controlar la ESP32 desde Raspberry Pi y leer telemetría.

## Requisitos

- Python 3.10+
- UART disponible en `/dev/serial0`
- `pyserial`

Instalación rápida:

```bash
cd /home/salus/codigo/RAPY_ESP32_COMMS
python3 -m pip install -r requirements.txt
```

## Ejecutar CLI

```bash
cd /home/salus/codigo/RAPY_ESP32_COMMS
python3 -m controller_server.rpy_esp32_comms
```

Con flags:

```bash
python3 -m controller_server.rpy_esp32_comms \
  --port /dev/serial0 \
  --baud 115200 \
  --tx-hz 50 \
  --telemetry-print-hz 10 \
  --max-reverse-mps 1.30 \
  --log-file /home/salus/codigo/RAPY_ESP32_COMMS/session.jsonl
```

## Comandos REPL

- `help`
- `status`
- `drive on|off`
- `estop on|off`
- `speed <mps signed>`
- `steer <int -100..100>`
- `brake <0..100>`
- `watch on|off`
- `log on|off`
- `quit`

## Seguridad

- Al iniciar, el estado sale en seguro: `drive=off`, `speed=0`, `steer=0`, `brake=0`, `estop=off`.
- Al salir, se envían 3 frames finales en estado seguro antes de cerrar UART.
- El TX Pi->ESP32 es continuo a 50 Hz por default.

## API pública

- `encode_pi_frame(state) -> bytes`
- `decode_esp_frame(frame) -> Telemetry`
- `CommsClient.start()`
- `CommsClient.stop()`
- `CommsClient.set_speed_mps(v)` (acepta positivos y negativos)
- `CommsClient.set_steer_pct(v)`
- `CommsClient.set_brake_pct(v)`
- `CommsClient.set_drive_enabled(v)`
- `CommsClient.set_estop(v)`
- `CommsClient.get_latest_telemetry()`

## Protocolo UART v2

### Pi -> ESP32 (7 bytes)

`0xAA | ver_flags(v=2) | steer_i8 | speed_cmd_u16_le(m/s x100) | brake_u8 | crc8`

- `ver_flags`:
  - bit0: `ESTOP`
  - bit1: `DRIVE_EN`
  - bit2: `REV_REQ`

### ESP32 -> Pi (8 bytes)

`0x55 | status_flags | speed_meas_u16_le | steer_meas_i16_le | brake_applied_u8 | crc8`

Sentinels:

- `speed_meas_u16 == 0xFFFF` -> `speed_mps=None`
- `steer_meas_i16 == -32768` -> `steer_deg=None`

## Tests

```bash
cd /home/salus/codigo/ros2/workspace/src/controller_server/controller_server/controller
PYTHONPATH=../.. python3 -m pytest -q
```

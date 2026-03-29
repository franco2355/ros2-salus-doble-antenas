from __future__ import annotations

import struct
import time
from typing import Iterable, List, Optional

from .controller import CommandState
from .telemetry import Telemetry

PI_HEADER = 0xAA
ESP_HEADER = 0x55
PI_FRAME_SIZE = 7
ESP_FRAME_SIZE = 8
PROTOCOL_VERSION = 2

CMD_FLAG_ESTOP = 1 << 0
CMD_FLAG_DRIVE_EN = 1 << 1
CMD_FLAG_REV_REQ = 1 << 2

SPEED_SENTINEL = 0xFFFF
STEER_SENTINEL = -32768


def crc8_maxim(data: bytes) -> int:
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x31) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


def encode_pi_frame(state: CommandState) -> bytes:
    flags = 0
    if state.estop:
        flags |= CMD_FLAG_ESTOP
    if state.drive_enabled:
        flags |= CMD_FLAG_DRIVE_EN

    signed_speed_mps = float(state.speed_mps)
    if signed_speed_mps < 0.0:
        flags |= CMD_FLAG_REV_REQ

    ver_flags = ((PROTOCOL_VERSION & 0x0F) << 4) | (flags & 0x0F)
    steer_i8 = max(-100, min(100, int(state.steer_pct)))
    speed_centi_mps = max(0, min(65535, int(round(abs(signed_speed_mps) * 100.0))))
    brake_u8 = max(0, min(100, int(state.brake_pct)))

    frame = bytearray(PI_FRAME_SIZE)
    frame[0] = PI_HEADER
    frame[1] = ver_flags
    frame[2] = steer_i8 & 0xFF
    frame[3] = speed_centi_mps & 0xFF
    frame[4] = (speed_centi_mps >> 8) & 0xFF
    frame[5] = brake_u8
    frame[6] = crc8_maxim(frame[:-1])
    return bytes(frame)


def decode_esp_frame(frame: bytes, rx_monotonic_s: Optional[float] = None) -> Telemetry:
    if len(frame) != ESP_FRAME_SIZE:
        raise ValueError(f"Invalid ESP frame length: {len(frame)}")
    if frame[0] != ESP_HEADER:
        raise ValueError(f"Invalid ESP frame header: 0x{frame[0]:02X}")

    expected_crc = crc8_maxim(frame[:-1])
    if frame[-1] != expected_crc:
        raise ValueError(
            f"Invalid ESP frame CRC: got 0x{frame[-1]:02X}, expected 0x{expected_crc:02X}"
        )

    status_flags = frame[1]
    speed_raw = frame[2] | (frame[3] << 8)
    steer_raw = struct.unpack("<h", frame[4:6])[0]
    brake_applied_pct = frame[6]

    speed_mps = None if speed_raw == SPEED_SENTINEL else (speed_raw / 100.0)
    steer_deg = None if steer_raw == STEER_SENTINEL else (steer_raw / 100.0)

    return Telemetry(
        status_flags=status_flags,
        speed_mps=speed_mps,
        steer_deg=steer_deg,
        brake_applied_pct=brake_applied_pct,
        raw_speed_centi_mps=speed_raw,
        raw_steer_centi_deg=steer_raw,
        rx_monotonic_s=time.monotonic() if rx_monotonic_s is None else rx_monotonic_s,
    )


class EspFrameParser:
    """Streaming parser with CRC-aware re-sync for fixed-size ESP telemetry frames."""

    __slots__ = ("_buffer", "dropped_partial_frames", "crc_error_frames")

    def __init__(self) -> None:
        self._buffer = bytearray()
        self.dropped_partial_frames = 0
        self.crc_error_frames = 0

    def reset(self) -> None:
        self._buffer.clear()

    def feed(self, data: bytes) -> List[bytes]:
        frames: List[bytes] = []
        if not data:
            return frames

        self._buffer.extend(data)

        while len(self._buffer) >= ESP_FRAME_SIZE:
            if self._buffer[0] != ESP_HEADER:
                header_index = self._buffer.find(ESP_HEADER)
                if header_index == -1:
                    self.dropped_partial_frames += len(self._buffer)
                    self._buffer.clear()
                    break
                if header_index > 0:
                    self.dropped_partial_frames += header_index
                    del self._buffer[:header_index]

            if len(self._buffer) < ESP_FRAME_SIZE:
                break

            candidate = bytes(self._buffer[:ESP_FRAME_SIZE])
            expected_crc = crc8_maxim(candidate[:-1])
            if candidate[-1] == expected_crc:
                frames.append(candidate)
                del self._buffer[:ESP_FRAME_SIZE]
                continue

            self.crc_error_frames += 1
            self.dropped_partial_frames += 1
            del self._buffer[0]

        return frames


def decode_stream_chunks(chunks: Iterable[bytes]) -> List[Telemetry]:
    parser = EspFrameParser()
    out: List[Telemetry] = []
    for chunk in chunks:
        for frame in parser.feed(chunk):
            out.append(decode_esp_frame(frame))
    return out

#!/usr/bin/env python3
"""Deterministic Pi->ESP32 UART sender with status telemetry inspection."""

from __future__ import annotations

import argparse
import csv
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import serial


FLAG_DRIVE_EN = 0x02
VERSION_MAJOR = 0x1


@dataclass(frozen=True)
class UartStep:
    label: str
    accel: int
    brake: int
    duration_s: float


DEFAULT_STEPS = (
    UartStep("stop_init", accel=0, brake=60, duration_s=3.0),
    UartStep("step_2kmh", accel=12, brake=0, duration_s=8.0),
    UartStep("step_4kmh", accel=22, brake=0, duration_s=8.0),
    UartStep("step_1kmh", accel=6, brake=0, duration_s=8.0),
    UartStep("stop_final", accel=0, brake=60, duration_s=5.0),
)


def crc8_maxim(data: bytes) -> int:
    c = 0x00
    for b in data:
        c ^= b
        for _ in range(8):
            if c & 0x80:
                c = ((c << 1) ^ 0x31) & 0xFF
            else:
                c = (c << 1) & 0xFF
    return c


def int8_to_u8(value: int) -> int:
    if value < -128 or value > 127:
        raise ValueError(f"int8 out of range: {value}")
    return value & 0xFF


def build_command_frame(steer: int, accel: int, brake: int, flags: int) -> bytes:
    ver_flags = ((VERSION_MAJOR & 0x0F) << 4) | (flags & 0x0F)
    payload = bytes(
        [
            0xAA,
            ver_flags,
            int8_to_u8(steer),
            int8_to_u8(accel),
            max(0, min(100, int(brake))) & 0xFF,
        ]
    )
    return payload + bytes([crc8_maxim(payload)])


def parse_status_frames(
    rx_buffer: bytearray,
    stats: dict[str, int],
) -> list[tuple[int, int]]:
    frames: list[tuple[int, int]] = []
    i = 0
    while i <= len(rx_buffer) - 4:
        if rx_buffer[i] != 0x55:
            i += 1
            continue

        stats["header_candidates"] += 1
        packet = bytes(rx_buffer[i : i + 4])
        if crc8_maxim(packet[:3]) == packet[3]:
            frames.append((packet[1], packet[2]))
            stats["valid_frames"] += 1
            i += 4
        else:
            stats["crc_errors"] += 1
            i += 1

    if i:
        del rx_buffer[:i]
    return frames


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Send deterministic UART steps at fixed rate and inspect status."
    )
    parser.add_argument("--serial-port", default="/dev/serial0")
    parser.add_argument("--baudrate", type=int, default=460800)
    parser.add_argument("--tx-hz", type=float, default=100.0)
    parser.add_argument("--steer", type=int, default=0)
    parser.add_argument("--transitions-csv", default="/tmp/uart_step_events.csv")
    parser.add_argument(
        "--require-telemetry",
        action="store_true",
        help="Exit with code 2 when accel phases have no telemetry_u8 in 1..254.",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    if args.tx_hz <= 0.0:
        raise SystemExit("--tx-hz must be > 0")

    event_fp = None
    event_writer = None
    if args.transitions_csv:
        events_path = Path(args.transitions_csv)
        events_path.parent.mkdir(parents=True, exist_ok=True)
        event_fp = events_path.open("w", encoding="utf-8", newline="")
        event_writer = csv.writer(event_fp)
        event_writer.writerow(
            ["label", "start_epoch", "accel_cmd", "brake_cmd", "duration_s"]
        )

    serial_link = serial.Serial(
        args.serial_port,
        args.baudrate,
        timeout=0.0,
        write_timeout=0.0,
    )
    serial_link.reset_input_buffer()
    serial_link.reset_output_buffer()

    stats = {
        "header_candidates": 0,
        "valid_frames": 0,
        "crc_errors": 0,
    }
    telemetry_counts: Counter[int] = Counter()
    status_counts: Counter[int] = Counter()
    per_phase_nonzero = defaultdict(int)
    tx_timestamps = []
    rx_buffer = bytearray()

    tx_period = 1.0 / args.tx_hz
    next_tx = time.monotonic()

    try:
        for step in DEFAULT_STEPS:
            stage_start_epoch = time.time()
            stage_end_mono = time.monotonic() + step.duration_s
            if event_writer is not None:
                event_writer.writerow(
                    [
                        step.label,
                        f"{stage_start_epoch:.9f}",
                        int(step.accel),
                        int(step.brake),
                        f"{step.duration_s:.3f}s",
                    ]
                )
                event_fp.flush()

            print(
                f"[UART_STEP] {step.label} accel={step.accel} brake={step.brake} "
                f"dur={step.duration_s:.1f}s",
                flush=True,
            )

            while True:
                now = time.monotonic()
                if now >= stage_end_mono:
                    break

                if now >= next_tx:
                    frame = build_command_frame(
                        steer=args.steer,
                        accel=step.accel,
                        brake=step.brake,
                        flags=FLAG_DRIVE_EN,
                    )
                    serial_link.write(frame)
                    tx_timestamps.append(now)
                    next_tx += tx_period
                    if now - next_tx > tx_period:
                        next_tx = now + tx_period

                raw = serial_link.read(256)
                if raw:
                    rx_buffer.extend(raw)
                    for status, telemetry in parse_status_frames(rx_buffer, stats):
                        status_counts[status] += 1
                        telemetry_counts[telemetry] += 1
                        if step.accel > 0 and 1 <= telemetry <= 254:
                            per_phase_nonzero[step.label] += 1

                time.sleep(0.0005)
    finally:
        serial_link.close()
        if event_fp is not None:
            event_fp.close()

    periods = []
    if len(tx_timestamps) > 1:
        for idx in range(1, len(tx_timestamps)):
            periods.append(tx_timestamps[idx] - tx_timestamps[idx - 1])

    avg_period = sum(periods) / len(periods) if periods else 0.0
    avg_hz = (1.0 / avg_period) if avg_period > 0.0 else 0.0
    max_jitter = max(abs(p - tx_period) for p in periods) if periods else 0.0

    print(f"tx_frames={len(tx_timestamps)}")
    print(f"tx_avg_hz={avg_hz:.3f}")
    print(f"tx_max_jitter_s={max_jitter:.6f}")
    print(f"status_top={status_counts.most_common(5)}")
    print(f"telemetry_top={telemetry_counts.most_common(10)}")
    print(
        "uart_parse="
        f"valid={stats['valid_frames']} crc_errors={stats['crc_errors']} "
        f"headers={stats['header_candidates']}"
    )

    accel_nonzero_total = sum(per_phase_nonzero.values())
    for step in DEFAULT_STEPS:
        if step.accel > 0:
            print(
                f"phase={step.label} telemetry_nonzero_samples="
                f"{per_phase_nonzero[step.label]}"
            )

    if args.require_telemetry and accel_nonzero_total == 0:
        print("precheck_result=BLOCKED_BY_TELEMETRY")
        return 2

    print("precheck_result=OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

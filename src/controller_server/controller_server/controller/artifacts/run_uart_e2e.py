#!/usr/bin/env python3
from __future__ import annotations

import json
import socket
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from controller_server.rpy_esp32_comms.transport import CommsClient


class TelnetCapture:
    def __init__(self, host: str, port: int = 23, timeout_s: float = 3.0) -> None:
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.sock: Optional[socket.socket] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lines: List[str] = []
        self._lines_lock = threading.Lock()
        self._partial = ""

    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout_s)
        self.sock.settimeout(0.2)
        self._thread = threading.Thread(
            target=self._reader_loop,
            daemon=True,
            name="esp32-telnet-reader",
        )
        self._thread.start()
        time.sleep(0.5)

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def send(self, cmd: str) -> None:
        if self.sock is None:
            raise RuntimeError("telnet socket not connected")
        payload = (cmd.strip() + "\n").encode("utf-8", errors="ignore")
        self.sock.sendall(payload)

    def line_count(self) -> int:
        with self._lines_lock:
            return len(self._lines)

    def lines_since(self, index: int) -> List[str]:
        with self._lines_lock:
            return list(self._lines[index:])

    def _append_line(self, line: str) -> None:
        stamped = f"{time.time():.3f} {line.rstrip()}"
        with self._lines_lock:
            self._lines.append(stamped)

    def _reader_loop(self) -> None:
        while not self._stop.is_set():
            if self.sock is None:
                break
            try:
                data = self.sock.recv(4096)
                if not data:
                    break
                text = data.decode("utf-8", errors="ignore").replace("\r", "")
                text = self._partial + text
                parts = text.split("\n")
                self._partial = parts[-1]
                for line in parts[:-1]:
                    line = line.strip()
                    if line:
                        self._append_line(line)
            except socket.timeout:
                continue
            except OSError:
                break


def telemetry_to_dict(tlm: Any) -> Optional[Dict[str, Any]]:
    if tlm is None:
        return None
    return tlm.as_dict()


def snapshot(client: CommsClient) -> Dict[str, Any]:
    stats = client.get_stats()
    return {
        "ts": time.time(),
        "desired": client.get_command_state(),
        "telemetry": telemetry_to_dict(client.get_latest_telemetry()),
        "stats": asdict(stats),
    }


def capture_status(
    capture: TelnetCapture,
    extra_cmds: Optional[List[str]] = None,
    wait_s: float = 0.35,
) -> List[str]:
    idx = capture.line_count()
    capture.send("comms.status")
    if extra_cmds:
        for cmd in extra_cmds:
            capture.send(cmd)
    time.sleep(wait_s)
    return capture.lines_since(idx)


def main() -> int:
    out_dir = Path("/home/salus/codigo/RAPY_ESP32_COMMS/artifacts")
    out_dir.mkdir(parents=True, exist_ok=True)

    result_path = out_dir / "uart_e2e_results.json"
    telnet_log_path = out_dir / "uart_e2e_esp32_telnet.log"

    capture = TelnetCapture(host="esp32-salus.local", port=23)
    client = CommsClient(port="/dev/serial0", baud=115200, tx_hz=50.0)

    steps: List[Dict[str, Any]] = []

    try:
        capture.connect()
        time.sleep(0.3)

        # Setup logging on ESP32 side.
        for cmd in [
            "net.status",
            "comms.reset",
            "drive.log on",
            "drive.log pid on 200",
            "spid.stream on 250",
            "speed.stream on 250",
        ]:
            capture.send(cmd)
            time.sleep(0.2)

        client.start()
        time.sleep(1.0)

        scenario = [
            ("baseline_safe", 1.0, lambda: None),
            ("drive_on", 1.0, lambda: client.set_drive_enabled(True)),
            ("speed_0_80", 2.0, lambda: client.set_speed_mps(0.80)),
            ("steer_30", 1.5, lambda: client.set_steer_pct(30)),
            ("speed_1_60", 2.0, lambda: client.set_speed_mps(1.60)),
            ("brake_40", 2.0, lambda: client.set_brake_pct(40)),
            ("brake_0", 1.5, lambda: client.set_brake_pct(0)),
            ("steer_-35", 1.5, lambda: client.set_steer_pct(-35)),
            ("speed_0_60", 1.5, lambda: client.set_speed_mps(0.60)),
            ("estop_on", 2.0, lambda: client.set_estop(True)),
            ("estop_off", 1.5, lambda: client.set_estop(False)),
            ("drive_off", 1.5, lambda: client.set_drive_enabled(False)),
            (
                "safe_reset",
                1.0,
                lambda: (
                    client.set_speed_mps(0.0),
                    client.set_steer_pct(0),
                    client.set_brake_pct(0),
                ),
            ),
        ]

        for name, hold_s, action in scenario:
            action()
            immediate_logs = capture_status(
                capture,
                extra_cmds=["spid.status"],
                wait_s=0.45,
            )
            time.sleep(hold_s)
            held_logs = capture_status(capture, wait_s=0.35)

            step_entry = {
                "step": name,
                "hold_s": hold_s,
                "snapshot": snapshot(client),
                "esp32_logs_immediate": immediate_logs,
                "esp32_logs_after_hold": held_logs,
            }
            steps.append(step_entry)

        # Collect last logs and cleanup.
        cleanup_idx = capture.line_count()
        for cmd in [
            "speed.stream off",
            "spid.stream off",
            "drive.log pid off",
            "drive.log off",
            "comms.status",
        ]:
            capture.send(cmd)
            time.sleep(0.15)

        time.sleep(0.4)
        cleanup_logs = capture.lines_since(cleanup_idx)

        result = {
            "started_ts": time.time(),
            "esp32_host": "esp32-salus.local",
            "uart_port": "/dev/serial0",
            "steps": steps,
            "final_snapshot": snapshot(client),
            "cleanup_logs": cleanup_logs,
        }

        all_telnet_lines = capture.lines_since(0)
        telnet_log_path.write_text(
            "\n".join(all_telnet_lines) + "\n",
            encoding="utf-8",
        )
        result_path.write_text(
            json.dumps(result, indent=2, ensure_ascii=True),
            encoding="utf-8",
        )

        print(f"OK: wrote {result_path}")
        print(f"OK: wrote {telnet_log_path}")

    finally:
        try:
            client.stop()
        except Exception:
            pass
        capture.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

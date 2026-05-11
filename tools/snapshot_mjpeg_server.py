#!/usr/bin/env python3
"""
Hikvision snapshot MJPEG relay.

Polls CAMERA_SNAPSHOT_URL (/ISAPI/Streaming/channels/101/picture) with
HTTP Digest auth at TARGET_FPS and re-serves frames as a multipart MJPEG stream.
No ffmpeg, no H.264, no GOP buffering — latency ~100-150 ms.

Endpoints:
  /stream.mjpg  — multipart MJPEG (boundary=frame)
  /snap.jpg     — latest JPEG
  /             — minimal HTML preview
"""
from __future__ import annotations

import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request

CAMERA_SNAPSHOT_URL: str = os.environ.get(
    "CAMERA_SNAPSHOT_URL",
    "http://192.168.1.64/ISAPI/Streaming/channels/101/picture",
)
CAMERA_USER: str = os.environ.get("CAMERA_USER", "admin")
CAMERA_PASS: str = os.environ.get("CAMERA_PASS", "teamcit2024")
HTTP_PORT: int = int(os.environ.get("HTTP_PORT", "8089"))
TARGET_FPS: float = float(os.environ.get("TARGET_FPS", "10"))
BOUNDARY: bytes = b"frame"

_latest_jpeg: bytes = b""
_frame_seq: int = 0
_frame_lock: threading.Condition = threading.Condition()
_stop: threading.Event = threading.Event()


def _make_opener() -> urllib.request.OpenerDirector:
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, CAMERA_SNAPSHOT_URL, CAMERA_USER, CAMERA_PASS)
    return urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(mgr))


def _capture_loop() -> None:
    global _latest_jpeg, _frame_seq
    opener = _make_opener()
    interval = 1.0 / TARGET_FPS
    while not _stop.is_set():
        t0 = time.monotonic()
        try:
            with opener.open(CAMERA_SNAPSHOT_URL, timeout=2) as resp:
                data: bytes = resp.read()
            if data:
                with _frame_lock:
                    _latest_jpeg = data
                    _frame_seq += 1
                    _frame_lock.notify_all()
        except Exception as exc:
            print(f"[snap-relay] fetch error: {exc}", flush=True)
        elapsed = time.monotonic() - t0
        _stop.wait(max(0.0, interval - elapsed))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args, **_kwargs) -> None:
        pass

    def do_GET(self) -> None:
        if self.path.startswith("/stream.mjpg"):
            self._serve_stream()
        elif self.path.startswith("/snap.jpg"):
            self._serve_snap()
        else:
            self._serve_index()

    def _serve_stream(self) -> None:
        self.send_response(200)
        self.send_header(
            "Content-Type",
            f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
        )
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        last_seq = -1
        while True:
            with _frame_lock:
                if not _frame_lock.wait_for(
                    lambda: _frame_seq != last_seq, timeout=3.0
                ):
                    continue
                frame = _latest_jpeg
                last_seq = _frame_seq
            if not frame:
                continue
            try:
                self.wfile.write(
                    b"--" + BOUNDARY + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    + f"Content-Length: {len(frame)}\r\n\r\n".encode()
                    + frame
                    + b"\r\n"
                )
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

    def _serve_snap(self) -> None:
        with _frame_lock:
            frame = _latest_jpeg
        if not frame:
            self.send_response(503)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(frame)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(frame)

    def _serve_index(self) -> None:
        html = (
            b"<!doctype html><html><head><meta charset='utf-8'>"
            b"<style>body{margin:0;background:#000;display:flex;align-items:center;"
            b"justify-content:center;height:100vh}img{max-width:100%;max-height:100vh;"
            b"object-fit:contain}</style></head><body>"
            b"<img src='/stream.mjpg' alt='snapshot relay'>"
            b"</body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)


def _shutdown(*_args) -> None:
    _stop.set()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    print(f"[snap-relay] serving : http://0.0.0.0:{HTTP_PORT}/", flush=True)
    print(f"[snap-relay] source  : {CAMERA_SNAPSHOT_URL}", flush=True)
    print(f"[snap-relay] fps     : {TARGET_FPS}", flush=True)
    threading.Thread(target=_capture_loop, daemon=True).start()
    try:
        ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever()
    finally:
        _shutdown()

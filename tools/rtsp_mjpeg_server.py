#!/usr/bin/env python3
"""
RTSP to MJPEG relay for low-latency camera preview.

Reads a Hikvision RTSP stream with ffmpeg, keeps the latest JPEG in memory,
and serves:
  /stream.mjpg  multipart MJPEG stream
  /snap.jpg     latest decoded frame
  /             minimal live preview page
"""
from __future__ import annotations

import os
import json
import signal
import subprocess
import sys
import threading
import time
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

from PIL import Image, ImageDraw


CAMERA_RTSP_URL = os.environ.get(
    "CAMERA_RTSP_URL",
    "rtsp://admin:teamcit2024@192.168.1.64:554/Streaming/Channels/101",
)
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8089"))
OUTPUT_FPS = os.environ.get("OUTPUT_FPS", "10")
JPEG_QUALITY = os.environ.get("JPEG_QUALITY", "6")
SCALE = os.environ.get("SCALE", "1280:-2")
PROBESIZE = os.environ.get("PROBESIZE", "32768")
ANALYZEDURATION = os.environ.get("ANALYZEDURATION", "100000")
VISION_DATA_URL = os.environ.get("VISION_DATA_URL", "http://localhost:8088/data")
OVERLAY_ENABLED = os.environ.get("OVERLAY_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
DETECTIONS_TIMEOUT_S = float(os.environ.get("DETECTIONS_TIMEOUT_S", "1.0"))
BOUNDARY = b"frame"

_latest_jpeg: bytes = b""
_frame_seq = 0
_frame_lock = threading.Condition()
_stop = threading.Event()
_ffmpeg: subprocess.Popen[bytes] | None = None
_detections_lock = threading.Lock()
_latest_detections: list[dict] = []
_latest_detections_wall_time = 0.0
_latest_detection_source_size = (0.0, 0.0)


def _ffmpeg_cmd() -> list[str]:
    # Use scale only (no fps filter) — the fps filter adds a frame-timing buffer
    # that increases latency. Instead we throttle by dropping frames in _read_jpegs.
    vf = f"scale={SCALE}" if SCALE.strip() else ""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-fflags",
        "nobuffer+discardcorrupt",
        "-flags",
        "low_delay",
        "-probesize",
        PROBESIZE,
        "-analyzeduration",
        ANALYZEDURATION,
        # Avoid buffering delay from RTP jitter compensation
        "-reorder_queue_size",
        "0",
        "-i",
        CAMERA_RTSP_URL,
        "-an",
    ]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-q:v",
        JPEG_QUALITY,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
    ]
    return cmd


def _publish_frame(frame: bytes) -> None:
    global _latest_jpeg, _frame_seq
    if OVERLAY_ENABLED:
        frame = _draw_detections_on_jpeg(frame)
    with _frame_lock:
        _latest_jpeg = frame
        _frame_seq += 1
        _frame_lock.notify_all()


def _vision_data_loop() -> None:
    global _latest_detections, _latest_detections_wall_time, _latest_detection_source_size
    while not _stop.is_set():
        try:
            with urlopen(f"{VISION_DATA_URL}?_={time.time():.3f}", timeout=1.0) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            camera = payload.get("camera") if isinstance(payload, dict) else {}
            ai = payload.get("ai") if isinstance(payload, dict) else {}
            detections = ai.get("detections") if isinstance(ai, dict) else []
            if not isinstance(detections, list):
                detections = []
            width = float(camera.get("width") or 0.0) if isinstance(camera, dict) else 0.0
            height = float(camera.get("height") or 0.0) if isinstance(camera, dict) else 0.0
            with _detections_lock:
                _latest_detections = detections
                _latest_detections_wall_time = time.time()
                _latest_detection_source_size = (width, height)
        except Exception:
            pass
        _stop.wait(0.2)


def _draw_detections_on_jpeg(frame: bytes) -> bytes:
    with _detections_lock:
        detections = list(_latest_detections)
        detections_age = time.time() - _latest_detections_wall_time if _latest_detections_wall_time > 0 else 999.0
        src_w, src_h = _latest_detection_source_size

    if not detections or detections_age > DETECTIONS_TIMEOUT_S or src_w <= 0 or src_h <= 0:
        return frame

    try:
        image = Image.open(BytesIO(frame)).convert("RGB")
        draw = ImageDraw.Draw(image)
        frame_w, frame_h = image.size
        sx = frame_w / src_w
        sy = frame_h / src_h

        for det in detections:
            if not isinstance(det, dict):
                continue
            bbox = det.get("bbox")
            if not isinstance(bbox, dict):
                continue
            try:
                cx = float(bbox.get("cx", 0.0)) * sx
                cy = float(bbox.get("cy", 0.0)) * sy
                width = float(bbox.get("width", 0.0)) * sx
                height = float(bbox.get("height", 0.0)) * sy
                score = float(det.get("score", 0.0))
            except (TypeError, ValueError):
                continue
            if width <= 0 or height <= 0:
                continue

            x1 = max(0, min(frame_w - 1, int(round(cx - width / 2.0))))
            y1 = max(0, min(frame_h - 1, int(round(cy - height / 2.0))))
            x2 = max(0, min(frame_w - 1, int(round(cx + width / 2.0))))
            y2 = max(0, min(frame_h - 1, int(round(cy + height / 2.0))))
            if x2 <= x1 or y2 <= y1:
                continue

            label = str(det.get("label") or "objeto")
            text = f"{label} {score * 100:.0f}%"
            green = (34, 197, 94)
            bg = (20, 83, 45)
            fg = (236, 253, 245)
            for inset in range(4):
                draw.rectangle((x1 + inset, y1 + inset, x2 - inset, y2 - inset), outline=green)
            text_box = draw.textbbox((0, 0), text)
            text_w = text_box[2] - text_box[0]
            text_h = text_box[3] - text_box[1]
            label_y1 = max(0, y1 - text_h - 10)
            label_x2 = min(frame_w - 1, x1 + text_w + 12)
            label_y2 = label_y1 + text_h + 10
            draw.rectangle((x1, label_y1, label_x2, label_y2), fill=bg)
            draw.text((x1 + 6, label_y1 + 5), text, fill=fg)

        output = BytesIO()
        image.save(output, format="JPEG", quality=82)
        return output.getvalue()
    except Exception:
        return frame


def _read_jpegs(stdout) -> None:
    buffer = bytearray()
    while not _stop.is_set():
        chunk = stdout.read(65536)
        if not chunk:
            return
        buffer.extend(chunk)
        # Drain all complete JPEGs from the buffer but only publish the LAST one.
        # This prevents frame backlog accumulation when the pipe fills faster than
        # the HTTP clients consume — the root cause of the visible stream delay.
        last_frame: bytes | None = None
        while True:
            start = buffer.find(b"\xff\xd8")
            if start < 0:
                buffer.clear()
                break
            end = buffer.find(b"\xff\xd9", start + 2)
            if end < 0:
                if start > 0:
                    del buffer[:start]
                break
            last_frame = bytes(buffer[start : end + 2])
            del buffer[: end + 2]
        if last_frame:
            _publish_frame(last_frame)


def _ffmpeg_loop() -> None:
    global _ffmpeg
    while not _stop.is_set():
        cmd = _ffmpeg_cmd()
        print(f"[rtsp-cam] starting ffmpeg: {' '.join(cmd)}", flush=True)
        try:
            _ffmpeg = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
            )
            if _ffmpeg.stdout is not None:
                _read_jpegs(_ffmpeg.stdout)
            code = _ffmpeg.wait(timeout=2)
            print(f"[rtsp-cam] ffmpeg exited: {code}", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[rtsp-cam] ffmpeg error: {exc}", file=sys.stderr, flush=True)
        finally:
            if _ffmpeg is not None and _ffmpeg.poll() is None:
                _ffmpeg.terminate()
            _ffmpeg = None
        if not _stop.is_set():
            time.sleep(1.0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args, **kwargs) -> None:
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
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        last_seq = -1
        while True:
            with _frame_lock:
                if not _frame_lock.wait_for(lambda: _frame_seq != last_seq, timeout=2.0):
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
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>body{margin:0;background:#000;display:flex;align-items:center;"
            "justify-content:center;height:100vh;overflow:hidden}img{max-width:100%;"
            "max-height:100vh;object-fit:contain}</style></head><body>"
            "<img id='cam' src='/stream.mjpg' alt='camera stream'>"
            "</body></html>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)


def _shutdown(*_args) -> None:
    _stop.set()
    if _ffmpeg is not None and _ffmpeg.poll() is None:
        _ffmpeg.terminate()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    print(f"[rtsp-cam] serving      : http://0.0.0.0:{HTTP_PORT}/", flush=True)
    print(f"[rtsp-cam] rtsp source  : {CAMERA_RTSP_URL}", flush=True)
    print(f"[rtsp-cam] output fps   : {OUTPUT_FPS}", flush=True)
    print(f"[rtsp-cam] overlay      : {'enabled' if OVERLAY_ENABLED else 'disabled'}", flush=True)
    if OVERLAY_ENABLED:
        print(f"[rtsp-cam] vision data  : {VISION_DATA_URL}", flush=True)
        threading.Thread(target=_vision_data_loop, daemon=True).start()
    threading.Thread(target=_ffmpeg_loop, daemon=True).start()
    try:
        ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever()
    finally:
        _shutdown()

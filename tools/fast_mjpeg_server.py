#!/usr/bin/env python3
"""
fast_mjpeg_server.py — low-latency MJPEG server via Hikvision ISAPI snapshots.

Bypasses RTSP + H.264 GOP buffering entirely.
Polls /ISAPI/Streaming/channels/{ch}/picture at full speed
using N parallel threads, serves latest frame as MJPEG HTTP.

Expected latency: ~150-250 ms end-to-end (vs 2+ sec with H.264 RTSP).

Usage:
  CAMERA_HOST=192.168.1.64 CAMERA_USER=admin CAMERA_PASS=teamcit2024 \
  python3 tools/fast_mjpeg_server.py

Env vars:
  CAMERA_HOST     camera IP                  [required]
  CAMERA_USER     HTTP user                  [default: admin]
  CAMERA_PASS     HTTP password              [default: ]
  CAMERA_CHANNEL  ISAPI channel number       [default: 102]
  HTTP_PORT       serving port               [default: 8089]
  FETCH_THREADS   parallel fetch threads     [default: 3]
  TARGET_FPS      max FPS to serve           [default: 25]
"""
import os
import sys
import time
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.request import (
    HTTPDigestAuthHandler,
    HTTPPasswordMgrWithDefaultRealm,
    build_opener,
)
from urllib.error import URLError

CAMERA_HOST    = os.environ.get("CAMERA_HOST", "")
CAMERA_USER    = os.environ.get("CAMERA_USER", "admin")
CAMERA_PASS    = os.environ.get("CAMERA_PASS", "")
CAMERA_CHANNEL = os.environ.get("CAMERA_CHANNEL", "102")
HTTP_PORT      = int(os.environ.get("HTTP_PORT", "8089"))
FETCH_THREADS  = int(os.environ.get("FETCH_THREADS", "3"))
TARGET_FPS     = int(os.environ.get("TARGET_FPS", "25"))

SNAPSHOT_URL   = f"http://{CAMERA_HOST}/ISAPI/Streaming/channels/{CAMERA_CHANNEL}/picture"
MIN_INTERVAL   = 1.0 / TARGET_FPS
BOUNDARY       = b"frame"

# Shared latest JPEG
_latest_jpeg: bytes = b""
_frame_seq: int = 0
_frame_lock = threading.Condition()


def _make_opener():
    """Build urllib opener with Digest auth."""
    mgr = HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, f"http://{CAMERA_HOST}/", CAMERA_USER, CAMERA_PASS)
    handler = HTTPDigestAuthHandler(mgr)
    return build_opener(handler)


_last_fetch_monotonic: float = 0.0


def _fetcher_loop(opener) -> None:
    """Continuously fetch JPEG snapshots and update shared state."""
    global _latest_jpeg, _frame_seq, _last_fetch_monotonic
    errors = 0

    while True:
        t0 = time.monotonic()
        try:
            with opener.open(SNAPSHOT_URL, timeout=3) as resp:
                data = resp.read()
            if data and data[:2] == b"\xff\xd8":
                with _frame_lock:
                    _latest_jpeg = data
                    _frame_seq += 1
                    _frame_lock.notify_all()
                _last_fetch_monotonic = time.monotonic()
                errors = 0
        except (URLError, OSError) as exc:
            errors += 1
            if errors <= 3:
                print(f"[fast-cam] fetch error: {exc}", file=sys.stderr)
            time.sleep(0.5)
            continue

        elapsed = time.monotonic() - t0
        wait = MIN_INTERVAL - elapsed
        if wait > 0:
            time.sleep(wait)


def _watchdog_loop() -> None:
    """Restart fetcher thread if it stops updating frames."""
    STALE_THRESHOLD = 5.0
    _start_monotonic = time.monotonic()
    while True:
        time.sleep(2.0)
        now = time.monotonic()
        if _last_fetch_monotonic == 0.0:
            # Never got a frame — if startup grace period passed, spawn a new fetcher
            if now - _start_monotonic > STALE_THRESHOLD:
                print("[fast-cam] watchdog: sin frames desde inicio, reiniciando fetcher...", file=sys.stderr)
                opener = _make_opener()
                t = threading.Thread(target=_fetcher_loop, args=(opener,), daemon=True)
                t.start()
                _start_monotonic = now
            continue
        age = now - _last_fetch_monotonic
        if age > STALE_THRESHOLD:
            print(f"[fast-cam] watchdog: sin frames por {age:.1f}s, reiniciando fetcher...", file=sys.stderr)
            opener = _make_opener()
            t = threading.Thread(target=_fetcher_loop, args=(opener,), daemon=True)
            t.start()


class MJPEGHandler(BaseHTTPRequestHandler):
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
        self.send_header(
            "Content-Type",
            f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
        )
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        last_seq = -1
        try:
            while True:
                with _frame_lock:
                    if not _frame_lock.wait_for(
                        lambda: _frame_seq != last_seq, timeout=1.0
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
        except Exception:
            return

    def _serve_snap(self) -> None:
        """Return latest JPEG immediately — used by JS polling."""
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
        interval_ms = max(200, int(1000 / max(1, TARGET_FPS)))
        html = (
            "<!doctype html><html><head>"
            "<meta charset='utf-8'>"
            "<style>"
            "body{margin:0;background:#000;color:#0f0;font-family:monospace;"
            "display:flex;flex-direction:column;align-items:center;"
            "justify-content:center;height:100vh;overflow:hidden}"
            "img{max-width:100%;max-height:90vh;object-fit:contain}"
            "#info{font-size:12px;padding:4px;opacity:0.7}"
            "</style></head><body>"
            '<img id="cam" alt="stream">'
            '<div id="info">connecting...</div>'
            "<script>"
            f"var INTERVAL={interval_ms};"
            "var img=document.getElementById('cam');"
            "var info=document.getElementById('info');"
            "function next(){"
            "  var t0=Date.now();"
            "  var n=new Image();"
            "  n.onload=function(){"
            "    img.src=n.src;"
            "    var lat=Date.now()-t0;"
            "    info.textContent='snap '+lat+'ms | '+new Date().toISOString().substr(11,8);"
            "    setTimeout(next,INTERVAL);"
            "  };"
            "  n.onerror=function(){info.textContent='error — retrying...';setTimeout(next,2000);};"
            "  n.src='/snap.jpg?_='+Date.now();"
            "}"
            "next();"
            "</script>"
            "</body></html>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)


if __name__ == "__main__":
    if not CAMERA_HOST:
        print("ERROR: CAMERA_HOST is not set.", file=sys.stderr)
        print(
            "Usage: CAMERA_HOST=192.168.1.64 CAMERA_USER=admin CAMERA_PASS=PASS "
            "python3 tools/fast_mjpeg_server.py",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[fast-cam] snapshot URL : {SNAPSHOT_URL}")
    print(f"[fast-cam] fetch threads: {FETCH_THREADS}")
    print(f"[fast-cam] target FPS   : {TARGET_FPS}")
    print(f"[fast-cam] serving      : http://0.0.0.0:{HTTP_PORT}/stream.mjpg")

    for _ in range(FETCH_THREADS):
        opener = _make_opener()
        t = threading.Thread(target=_fetcher_loop, args=(opener,), daemon=True)
        t.start()

    threading.Thread(target=_watchdog_loop, daemon=True).start()

    try:
        ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), MJPEGHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n[fast-cam] stopped")

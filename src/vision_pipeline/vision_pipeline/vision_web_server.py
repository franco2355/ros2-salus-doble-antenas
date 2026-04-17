#!/usr/bin/env python3

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional, Sequence

import cv2
import rclpy
from ament_index_python.packages import get_package_share_directory
from cv_bridge import CvBridge
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import Image
from std_msgs.msg import String
from vision_msgs.msg import Detection2DArray


def _stamp_to_float(stamp) -> Optional[float]:
    if stamp is None:
        return None
    return float(stamp.sec) + float(stamp.nanosec) * 1e-9


class VisionWebServerNode(Node):
    def __init__(self) -> None:
        super().__init__('vision_web_server')

        self.declare_parameter('image_topic', '/camera/image_raw')
        self.declare_parameter('debug_topic', '/objeto_detectado')
        self.declare_parameter('detections_topic', '/detections')
        self.declare_parameter('http_host', '0.0.0.0')
        self.declare_parameter('http_port', 8088)
        self.declare_parameter('html_path', '')
        self.declare_parameter('jpeg_quality', 90)
        self.declare_parameter('overlay_enabled', True)

        image_topic = str(self.get_parameter('image_topic').value)
        debug_topic = str(self.get_parameter('debug_topic').value)
        detections_topic = str(self.get_parameter('detections_topic').value)
        http_host = str(self.get_parameter('http_host').value)
        http_port = int(self.get_parameter('http_port').value)
        html_path = str(self.get_parameter('html_path').value)
        self._jpeg_quality = min(95, max(40, int(self.get_parameter('jpeg_quality').value)))
        self._overlay_enabled = bool(self.get_parameter('overlay_enabled').value)

        if not html_path:
            share_dir = Path(get_package_share_directory('vision_pipeline'))
            html_path = str(share_dir / 'web' / 'index.html')

        self._html_content = self._load_html(html_path)
        self._bridge = CvBridge()
        self._state_lock = threading.Lock()
        self._frame_condition = threading.Condition(self._state_lock)
        self._latest_jpeg: Optional[bytes] = None
        self._latest_frame_stamp: Optional[float] = None
        self._latest_frame_wall_time: Optional[float] = None
        self._latest_frame_shape = {'width': 0, 'height': 0}
        self._latest_frame_seq = 0
        self._latest_ai_text = 'Esperando inferencia...'
        self._latest_ai_wall_time: Optional[float] = None
        self._latest_detections_wall_time: Optional[float] = None
        self._latest_detections: list[dict] = []
        debug_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=5,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        self.create_subscription(Image, image_topic, self._image_cb, qos_profile_sensor_data)
        self.create_subscription(String, debug_topic, self._debug_cb, debug_qos)
        self.create_subscription(Detection2DArray, detections_topic, self._detections_cb, 10)

        self._httpd = self._start_http_server(http_host, http_port)
        self.get_logger().info(
            f'vision_web_server running at http://{http_host}:{http_port} '
            f'(image_topic={image_topic}, debug_topic={debug_topic}, detections_topic={detections_topic})'
        )

    def _load_html(self, html_path: str) -> str:
        try:
            return Path(html_path).read_text(encoding='utf-8')
        except Exception as exc:
            self.get_logger().error(f'failed to load HTML {html_path}: {exc}')
            return '<html><body>Missing dashboard HTML.</body></html>'

    def _image_cb(self, msg: Image) -> None:
        try:
            frame = self._bridge.imgmsg_to_cv2(msg, desired_encoding='bgr8')
        except Exception as exc:
            self.get_logger().warning(f'cannot decode image frame: {exc}')
            return

        if self._overlay_enabled:
            overlay_text = self._latest_ai_text
            preview = frame.copy()
            self._draw_overlay(preview, overlay_text)
        else:
            preview = frame

        ok, encoded = cv2.imencode(
            '.jpg',
            preview,
            [int(cv2.IMWRITE_JPEG_QUALITY), int(self._jpeg_quality)],
        )
        if not ok:
            self.get_logger().warning('cannot encode JPEG preview')
            return

        now = time.time()
        with self._frame_condition:
            self._latest_jpeg = encoded.tobytes()
            self._latest_frame_stamp = _stamp_to_float(msg.header.stamp)
            self._latest_frame_wall_time = now
            self._latest_frame_shape = {
                'width': int(preview.shape[1]),
                'height': int(preview.shape[0]),
            }
            self._latest_frame_seq += 1
            self._frame_condition.notify_all()

    def _debug_cb(self, msg: String) -> None:
        with self._state_lock:
            self._latest_ai_text = str(msg.data).strip() or 'sin_detecciones'
            self._latest_ai_wall_time = time.time()

    def _detections_cb(self, msg: Detection2DArray) -> None:
        detections: list[dict] = []
        for detection in msg.detections:
            top_label = ''
            top_score = 0.0
            if detection.results:
                top_result = detection.results[0]
                top_label = str(top_result.hypothesis.class_id)
                top_score = float(top_result.hypothesis.score)

            detections.append(
                {
                    'id': str(detection.id),
                    'label': top_label,
                    'score': top_score,
                    'bbox': {
                        'cx': float(detection.bbox.center.position.x),
                        'cy': float(detection.bbox.center.position.y),
                        'width': float(detection.bbox.size_x),
                        'height': float(detection.bbox.size_y),
                    },
                }
            )

        with self._state_lock:
            self._latest_detections = detections
            self._latest_detections_wall_time = time.time()

    def _draw_overlay(self, frame, overlay_text: str) -> None:
        text = f'IA: {overlay_text or "sin_datos"}'
        margin = 14
        box_height = 42
        cv2.rectangle(
            frame,
            (margin, margin),
            (frame.shape[1] - margin, margin + box_height),
            (18, 30, 44),
            thickness=-1,
        )
        cv2.putText(
            frame,
            text[:96],
            (margin + 12, margin + 27),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (242, 247, 251),
            2,
            cv2.LINE_AA,
        )

    def _start_http_server(self, host: str, port: int) -> ThreadingHTTPServer:
        node = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                clean_path = self.path.split('?', 1)[0]
                if clean_path in ('/', '/index.html'):
                    self._send_response(200, 'text/html; charset=utf-8', node._html_content)
                    return
                if clean_path == '/snapshot.jpg':
                    node._send_snapshot(self)
                    return
                if clean_path == '/stream.mjpg':
                    node._send_mjpeg_stream(self)
                    return
                if clean_path == '/data':
                    self._send_response(200, 'application/json', node._get_snapshot())
                    return
                if clean_path == '/health':
                    self._send_response(200, 'application/json', node._get_health())
                    return
                if clean_path == '/favicon.ico':
                    self.send_response(204)
                    self.end_headers()
                    return
                self._send_response(404, 'text/plain; charset=utf-8', 'Not Found')

            def do_OPTIONS(self):  # noqa: N802
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.end_headers()

            def _send_response(self, code: int, content_type: str, body) -> None:
                if isinstance(body, str):
                    body = body.encode('utf-8')
                self.send_response(code)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):  # noqa: A003
                return

        httpd = ThreadingHTTPServer((host, port), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd

    def _send_snapshot(self, handler: BaseHTTPRequestHandler) -> None:
        with self._state_lock:
            payload = self._latest_jpeg

        if payload is None:
            body = b'No image available yet.'
            handler.send_response(503)
            handler.send_header('Content-Type', 'text/plain; charset=utf-8')
            handler.send_header('Content-Length', str(len(body)))
            handler.send_header('Cache-Control', 'no-store')
            handler.send_header('Access-Control-Allow-Origin', '*')
            handler.end_headers()
            handler.wfile.write(body)
            return

        handler.send_response(200)
        handler.send_header('Content-Type', 'image/jpeg')
        handler.send_header('Content-Length', str(len(payload)))
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Access-Control-Allow-Origin', '*')
        handler.end_headers()
        handler.wfile.write(payload)

    def _send_mjpeg_stream(self, handler: BaseHTTPRequestHandler) -> None:
        boundary = b'frame'
        handler.send_response(200)
        handler.send_header('Age', '0')
        handler.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
        handler.send_header('Pragma', 'no-cache')
        handler.send_header('Access-Control-Allow-Origin', '*')
        handler.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        handler.end_headers()

        last_seq = -1
        try:
            while rclpy.ok():
                with self._frame_condition:
                    if self._latest_jpeg is None:
                        self._frame_condition.wait(timeout=1.0)
                        continue
                    if self._latest_frame_seq == last_seq:
                        self._frame_condition.wait(timeout=0.25)
                        continue
                    payload = self._latest_jpeg
                    last_seq = self._latest_frame_seq

                handler.wfile.write(b'--' + boundary + b'\r\n')
                handler.wfile.write(b'Content-Type: image/jpeg\r\n')
                handler.wfile.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode('ascii'))
                handler.wfile.write(payload)
                handler.wfile.write(b'\r\n')
                handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def _get_snapshot(self) -> str:
        now = time.time()
        with self._state_lock:
            payload = {
                'camera': {
                    'available': self._latest_jpeg is not None,
                    'stamp': self._latest_frame_stamp,
                    'age_sec': None if self._latest_frame_wall_time is None else now - self._latest_frame_wall_time,
                    'width': self._latest_frame_shape['width'],
                    'height': self._latest_frame_shape['height'],
                },
                'ai': {
                    'text': self._latest_ai_text,
                    'age_sec': None if self._latest_ai_wall_time is None else now - self._latest_ai_wall_time,
                    'detections_age_sec': None
                    if self._latest_detections_wall_time is None
                    else now - self._latest_detections_wall_time,
                    'count': len(self._latest_detections),
                    'detections': list(self._latest_detections),
                },
                'server_time': now,
            }
        return json.dumps(payload)

    def _get_health(self) -> str:
        now = time.time()
        with self._state_lock:
            ok = self._latest_jpeg is not None and self._latest_frame_wall_time is not None
            age_sec = None if self._latest_frame_wall_time is None else now - self._latest_frame_wall_time
        return json.dumps({'ok': ok, 'camera_age_sec': age_sec})

    def destroy_node(self) -> bool:
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        except Exception:
            pass
        return super().destroy_node()


def main(args: Optional[Sequence[str]] = None) -> None:
    rclpy.init(args=args)
    node = VisionWebServerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()

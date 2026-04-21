#!/usr/bin/env python3

from __future__ import annotations

import os
import threading
import time
from typing import Optional, Sequence
from urllib.request import (
    HTTPDigestAuthHandler,
    HTTPPasswordMgrWithDefaultRealm,
    build_opener,
)
from urllib.error import URLError

import cv2
import numpy as np
import rclpy
from cv_bridge import CvBridge
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CameraInfo, Image


class IpCameraPublisherNode(Node):
    def __init__(self) -> None:
        super().__init__('ip_camera_publisher')

        self.declare_parameter('stream_url', '')
        self.declare_parameter('image_topic', '/camera/image_raw')
        self.declare_parameter('frame_id', 'camera_optical_frame')
        self.declare_parameter('target_fps', 15.0)
        self.declare_parameter('width', 640)
        self.declare_parameter('height', 480)
        self.declare_parameter('reconnect_interval_sec', 2.0)
        self.declare_parameter('read_timeout_sec', 3.0)
        self.declare_parameter('use_mjpeg', False)
        self.declare_parameter('rtsp_transport', 'tcp')
        self.declare_parameter('snapshot_user', '')
        self.declare_parameter('snapshot_pass', '')
        # CameraInfo — set publish_camera_info:=true and provide intrinsics.
        # Defaults assume 90° horizontal FOV on the configured image size.
        # For accurate fusion, replace with values from a real calibration.
        self.declare_parameter('publish_camera_info', False)
        self.declare_parameter('camera_info_topic', '/camera/camera_info')
        self.declare_parameter('camera_fx', 0.0)   # 0 → auto-estimate from width + hfov
        self.declare_parameter('camera_fy', 0.0)
        self.declare_parameter('camera_cx', 0.0)   # 0 → width/2
        self.declare_parameter('camera_cy', 0.0)   # 0 → height/2
        self.declare_parameter('camera_hfov_deg', 90.0)
        self.declare_parameter('camera_k1', 0.0)
        self.declare_parameter('camera_k2', 0.0)
        self.declare_parameter('camera_p1', 0.0)
        self.declare_parameter('camera_p2', 0.0)
        self.declare_parameter('camera_k3', 0.0)

        self._stream_url = str(self.get_parameter('stream_url').value)
        self._image_topic = str(self.get_parameter('image_topic').value)
        self._frame_id = str(self.get_parameter('frame_id').value)
        self._target_fps = max(1.0, float(self.get_parameter('target_fps').value))
        self._width = max(0, int(self.get_parameter('width').value))
        self._height = max(0, int(self.get_parameter('height').value))
        self._reconnect_interval_sec = max(0.5, float(self.get_parameter('reconnect_interval_sec').value))
        self._read_timeout_sec = max(0.5, float(self.get_parameter('read_timeout_sec').value))
        self._use_mjpeg = bool(self.get_parameter('use_mjpeg').value)
        self._rtsp_transport = self._normalize_rtsp_transport(
            str(self.get_parameter('rtsp_transport').value)
        )
        self._snapshot_user = str(self.get_parameter('snapshot_user').value).strip()
        self._snapshot_pass = str(self.get_parameter('snapshot_pass').value).strip()
        self._use_snapshot = self._stream_url.startswith('http') and (
            '/ISAPI/' in self._stream_url or '/snap.jpg' in self._stream_url or
            bool(self._snapshot_user)
        )
        self._is_network_stream = self._stream_url.startswith(
            ('rtsp://', 'rtsps://', 'http://', 'https://')
        )
        self._is_rtsp_stream = self._stream_url.startswith(('rtsp://', 'rtsps://'))

        if not self._stream_url:
            raise ValueError(
                'stream_url is required. Example: '
                'rtsp://admin:PASS@192.168.1.64:554/Streaming/Channels/101'
            )

        self._publish_camera_info = bool(self.get_parameter('publish_camera_info').value)
        self._camera_info_msg = self._build_camera_info() if self._publish_camera_info else None

        self._bridge = CvBridge()
        self._publisher = self.create_publisher(Image, self._image_topic, qos_profile_sensor_data)
        if self._publish_camera_info:
            _ci_topic = str(self.get_parameter('camera_info_topic').value)
            self._camera_info_pub = self.create_publisher(CameraInfo, _ci_topic, qos_profile_sensor_data)
        self._capture: Optional[cv2.VideoCapture] = None
        self._capture_lock = threading.Lock()
        self._stop_event = threading.Event()

        # Latest frame shared between reader and publisher threads.
        self._latest_frame = None
        self._latest_frame_lock = threading.Lock()
        self._latest_frame_event = threading.Event()

        self._last_frame_monotonic = 0.0
        self._last_connect_attempt_monotonic = 0.0

        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name='ip-camera-reader',
            daemon=True,
        )
        self._publisher_thread = threading.Thread(
            target=self._publisher_loop,
            name='ip-camera-publisher',
            daemon=True,
        )

        if self._use_snapshot:
            self._snapshot_opener = self._make_snapshot_opener()
            self.get_logger().info(
                f'ip_camera_publisher snapshot mode '
                f'(topic={self._image_topic}, fps={self._target_fps}, url={self._stream_url})'
            )
        else:
            self._snapshot_opener = None
            self._connect()
        self._reader_thread.start()
        self._publisher_thread.start()

    def _build_camera_info(self) -> CameraInfo:
        import math
        w = self._width if self._width > 0 else 640
        h = self._height if self._height > 0 else 360
        hfov = float(self.get_parameter('camera_hfov_deg').value)
        # Estimate focal length from FOV when not explicitly set.
        # fx = (w/2) / tan(hfov/2)
        fx_param = float(self.get_parameter('camera_fx').value)
        fy_param = float(self.get_parameter('camera_fy').value)
        cx_param = float(self.get_parameter('camera_cx').value)
        cy_param = float(self.get_parameter('camera_cy').value)
        fx = fx_param if fx_param > 0 else (w / 2.0) / math.tan(math.radians(hfov / 2.0))
        fy = fy_param if fy_param > 0 else fx
        cx = cx_param if cx_param > 0 else w / 2.0
        cy = cy_param if cy_param > 0 else h / 2.0
        k1 = float(self.get_parameter('camera_k1').value)
        k2 = float(self.get_parameter('camera_k2').value)
        p1 = float(self.get_parameter('camera_p1').value)
        p2 = float(self.get_parameter('camera_p2').value)
        k3 = float(self.get_parameter('camera_k3').value)

        msg = CameraInfo()
        msg.header.frame_id = self._frame_id
        msg.width = w
        msg.height = h
        msg.distortion_model = 'plumb_bob'
        msg.d = [k1, k2, p1, p2, k3]
        msg.k = [fx, 0.0, cx, 0.0, fy, cy, 0.0, 0.0, 1.0]
        msg.r = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        msg.p = [fx, 0.0, cx, 0.0, 0.0, fy, cy, 0.0, 0.0, 0.0, 1.0, 0.0]
        self.get_logger().info(
            f'camera_info: {w}x{h}, fx={fx:.1f} fy={fy:.1f} cx={cx:.1f} cy={cy:.1f} '
            f'(hfov={hfov}°, {"estimated" if fx_param == 0 else "from params"})'
        )
        return msg

    def _make_snapshot_opener(self):
        if self._snapshot_user and self._snapshot_pass:
            mgr = HTTPPasswordMgrWithDefaultRealm()
            mgr.add_password(None, self._stream_url, self._snapshot_user, self._snapshot_pass)
            return build_opener(HTTPDigestAuthHandler(mgr))
        return build_opener()

    def _normalize_rtsp_transport(self, raw_value: str) -> str:
        value = raw_value.strip().lower()
        if value in {'tcp', 'udp', 'auto'}:
            return value
        self.get_logger().warning(
            f"invalid rtsp_transport='{raw_value}', falling back to tcp"
        )
        return 'tcp'

    def _merge_ffmpeg_capture_options(self) -> Optional[str]:
        raw_options = os.environ.get('OPENCV_FFMPEG_CAPTURE_OPTIONS', '')
        parsed_options: dict[str, str] = {}
        option_order: list[str] = []

        for chunk in raw_options.split('|'):
            key, _, value = chunk.partition(';')
            key = key.strip()
            value = value.strip()
            if not key or not value:
                continue
            if key not in parsed_options:
                option_order.append(key)
            parsed_options[key] = value

        if self._is_rtsp_stream:
            # Low-latency defaults for RTSP — user options override these.
            # fflags=nobuffer disables demuxer input buffer.
            # flags=low_delay enables decoder low-delay mode.
            # max_delay caps accumulated delay at 200ms.
            # DO NOT set analyzeduration=0 or probesize too small —
            # that breaks H.264 stream analysis and causes more delay.
            low_latency_defaults = {
                'fflags': 'nobuffer',
                'flags': 'low_delay',
                'max_delay': '200000',
            }
            for key, value in low_latency_defaults.items():
                if key not in parsed_options:
                    option_order.append(key)
                    parsed_options[key] = value

            if self._rtsp_transport != 'auto':
                if 'rtsp_transport' not in parsed_options:
                    option_order.insert(0, 'rtsp_transport')
                parsed_options['rtsp_transport'] = self._rtsp_transport

        if not option_order:
            return None
        return '|'.join(f'{key};{parsed_options[key]}' for key in option_order)

    def _connect(self) -> None:
        now = time.monotonic()
        if now - self._last_connect_attempt_monotonic < self._reconnect_interval_sec:
            return
        self._last_connect_attempt_monotonic = now

        backend = cv2.CAP_FFMPEG
        capture = cv2.VideoCapture()
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        capture.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000.0)
        capture.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000.0)
        ffmpeg_capture_options = self._merge_ffmpeg_capture_options()
        if ffmpeg_capture_options:
            os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = ffmpeg_capture_options
        capture.open(self._stream_url, backend)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not self._is_network_stream:
            if self._width > 0:
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
            if self._height > 0:
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
            capture.set(cv2.CAP_PROP_FPS, self._target_fps)

        if not capture.isOpened():
            self.get_logger().error(f'cannot open stream: {self._stream_url}')
            capture.release()
            with self._capture_lock:
                if self._capture is not None:
                    self._capture.release()
                self._capture = None
            return

        with self._capture_lock:
            if self._capture is not None:
                self._capture.release()
            self._capture = capture

        self.get_logger().info(
            'ip_camera_publisher connected '
            f'(topic={self._image_topic}, fps={self._target_fps}, '
            f'url={self._stream_url}, rtsp_transport={self._rtsp_transport})'
        )

    def _normalize_frame(self, frame):
        if self._use_mjpeg and frame.ndim == 2:
            frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
        elif (
            self._is_network_stream
            and self._width > 0
            and self._height > 0
            and (frame.shape[1] != self._width or frame.shape[0] != self._height)
        ):
            # Resize after decode instead of negotiating unsupported capture props on RTSP/HTTP streams.
            frame = cv2.resize(frame, (self._width, self._height), interpolation=cv2.INTER_AREA)
        return frame

    def _reader_loop(self) -> None:
        if self._use_snapshot:
            self._snapshot_reader_loop()
        else:
            self._rtsp_reader_loop()

    def _snapshot_reader_loop(self) -> None:
        min_interval = 1.0 / self._target_fps
        errors = 0
        while not self._stop_event.is_set():
            t0 = time.monotonic()
            try:
                with self._snapshot_opener.open(self._stream_url, timeout=3) as resp:
                    data = resp.read()
                if data and data[:2] == b'\xff\xd8':
                    arr = np.frombuffer(data, dtype=np.uint8)
                    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                    if frame is not None:
                        if self._width > 0 and self._height > 0:
                            if frame.shape[1] != self._width or frame.shape[0] != self._height:
                                frame = cv2.resize(frame, (self._width, self._height), interpolation=cv2.INTER_AREA)
                        errors = 0
                        self._last_frame_monotonic = time.monotonic()
                        with self._latest_frame_lock:
                            self._latest_frame = frame
                        self._latest_frame_event.set()
            except (URLError, OSError):
                errors += 1
                if errors <= 3:
                    self.get_logger().warning(f'snapshot fetch error, retrying...')
                self._stop_event.wait(0.5)
                continue
            elapsed = time.monotonic() - t0
            wait = min_interval - elapsed
            if wait > 0:
                self._stop_event.wait(wait)

    def _rtsp_reader_loop(self) -> None:
        """Read frames from the RTSP source as fast as the camera delivers them."""
        while not self._stop_event.is_set():
            with self._capture_lock:
                capture = self._capture
            if capture is None:
                self._connect()
                self._stop_event.wait(0.05)
                continue

            ok, frame = capture.read()
            now = time.monotonic()

            if not ok or frame is None:
                if now - self._last_frame_monotonic >= self._read_timeout_sec:
                    if now - self._last_connect_attempt_monotonic >= self._reconnect_interval_sec:
                        self.get_logger().warning('stream read timeout, reconnecting')
                    self._connect()
                else:
                    self._stop_event.wait(0.01)
                continue

            self._last_frame_monotonic = now
            with self._latest_frame_lock:
                self._latest_frame = frame
            self._latest_frame_event.set()

    def _publisher_loop(self) -> None:
        """Publish the latest decoded frame at exactly target_fps.

        Runs independently from the reader so normalize+publish overhead
        (~30-60 ms) does not block camera.read() calls and the reader can
        keep draining the RTSP buffer continuously.
        """
        min_period = 1.0 / self._target_fps

        while not self._stop_event.is_set():
            loop_start = time.monotonic()

            # Wait up to one period for a new frame to be available.
            if not self._latest_frame_event.wait(timeout=min_period):
                continue
            self._latest_frame_event.clear()

            with self._latest_frame_lock:
                frame = self._latest_frame

            if frame is None:
                continue

            frame = self._normalize_frame(frame)

            stamp = self.get_clock().now().to_msg()
            msg = self._bridge.cv2_to_imgmsg(frame, encoding='bgr8')
            msg.header.stamp = stamp
            msg.header.frame_id = self._frame_id
            self._publisher.publish(msg)

            if self._publish_camera_info and self._camera_info_msg is not None:
                self._camera_info_msg.header.stamp = stamp
                self._camera_info_pub.publish(self._camera_info_msg)

            elapsed = time.monotonic() - loop_start
            remaining = min_period - elapsed
            if remaining > 0:
                self._stop_event.wait(remaining)

    def destroy_node(self) -> bool:
        self._stop_event.set()
        self._latest_frame_event.set()  # unblock publisher if waiting
        for thread in (self._reader_thread, self._publisher_thread):
            if thread.is_alive():
                thread.join(timeout=self._read_timeout_sec + 1.0)
        with self._capture_lock:
            if self._capture is not None:
                self._capture.release()
                self._capture = None
        return super().destroy_node()


def main(args: Optional[Sequence[str]] = None) -> None:
    rclpy.init(args=args)
    node = IpCameraPublisherNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

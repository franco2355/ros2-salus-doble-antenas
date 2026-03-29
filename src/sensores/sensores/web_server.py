#!/usr/bin/env python3
"""
ROS 2 node that serves a local HTML dashboard and exposes Pixhawk data as JSON.
"""

import asyncio
import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from ament_index_python.packages import get_package_share_directory
from sensor_msgs.msg import Imu, NavSatFix
from geometry_msgs.msg import TwistStamped
from nav_msgs.msg import Odometry
from std_msgs.msg import Float32, Int32, String
import websockets
from mavros_msgs.msg import GPSRAW


def _stamp_to_float(stamp):
    if stamp is None:
        return None
    return float(stamp.sec) + float(stamp.nanosec) * 1e-9


def _normalize_angle_rad(angle_rad: float) -> float:
    return math.atan2(math.sin(angle_rad), math.cos(angle_rad))


FIX_TYPE_NAMES = {
    0: 'NO_GPS',
    1: 'NO_FIX',
    2: '2D_FIX',
    3: '3D_FIX',
    4: 'DGPS',
    5: 'RTK_FLOAT',
    6: 'RTK_FIXED',
}


def _yaw_enu_from_quaternion(
    qx: float, qy: float, qz: float, qw: float
) -> tuple[float | None, float | None]:
    values = (qx, qy, qz, qw)
    if not all(math.isfinite(v) for v in values):
        return None, None

    yaw = math.atan2(
        2.0 * (qw * qz + qx * qy),
        1.0 - 2.0 * (qy * qy + qz * qz),
    )
    yaw = _normalize_angle_rad(yaw)
    yaw_deg = math.degrees(yaw)
    return yaw, yaw_deg


class PixhawkWebServer(Node):
    def __init__(self):
        super().__init__('sensores_web')

        self.declare_parameter('imu_topic', '/imu/data')
        self.declare_parameter('gps_topic', '/gps/fix')
        self.declare_parameter('fix_type_topic', '/gps/fix_type')
        self.declare_parameter('rtk_status_topic', '/gps/rtk_status')
        self.declare_parameter('rtcm_age_topic', '/gps/rtcm_age_s')
        self.declare_parameter('rtcm_count_topic', '/gps/rtcm_received_count')
        self.declare_parameter('gps_raw_topic', '/mavros_node/gps1/raw')
        self.declare_parameter('rtk_sources_config', '')
        self.declare_parameter('rtk_sources_topic', '/gps/rtk_sources/json')
        self.declare_parameter('rtk_source_status_topic', '/gps/rtk_source/status_json')
        self.declare_parameter('rtk_source_select_topic', '/gps/rtk_source/select')
        self.declare_parameter('rtk_source_manage_topic', '/gps/rtk_source/manage_json')
        self.declare_parameter('velocity_topic', '/velocity')
        self.declare_parameter('odom_topic', '/odom')
        self.declare_parameter('http_host', '0.0.0.0')
        self.declare_parameter('http_port', 8000)
        self.declare_parameter('ws_host', '0.0.0.0')
        self.declare_parameter('ws_port', 8001)
        self.declare_parameter('html_path', '')

        imu_topic = self.get_parameter('imu_topic').value
        gps_topic = self.get_parameter('gps_topic').value
        fix_type_topic = self.get_parameter('fix_type_topic').value
        rtk_status_topic = self.get_parameter('rtk_status_topic').value
        rtcm_age_topic = self.get_parameter('rtcm_age_topic').value
        rtcm_count_topic = self.get_parameter('rtcm_count_topic').value
        gps_raw_topic = self.get_parameter('gps_raw_topic').value
        rtk_sources_config = self.get_parameter('rtk_sources_config').value
        rtk_sources_topic = self.get_parameter('rtk_sources_topic').value
        rtk_source_status_topic = self.get_parameter('rtk_source_status_topic').value
        rtk_source_select_topic = self.get_parameter('rtk_source_select_topic').value
        rtk_source_manage_topic = self.get_parameter('rtk_source_manage_topic').value
        velocity_topic = self.get_parameter('velocity_topic').value
        odom_topic = self.get_parameter('odom_topic').value
        http_host = self.get_parameter('http_host').value
        http_port = self.get_parameter('http_port').value
        ws_host = self.get_parameter('ws_host').value
        ws_port = self.get_parameter('ws_port').value
        html_path = self.get_parameter('html_path').value
        self._topic_bindings = {
            'imu': str(imu_topic),
            'gps': str(gps_topic),
            'fix_type': str(fix_type_topic),
            'rtk_status': str(rtk_status_topic),
            'rtcm_age': str(rtcm_age_topic),
            'rtcm_count': str(rtcm_count_topic),
            'gps_raw': str(gps_raw_topic),
            'rtk_sources_config': str(rtk_sources_config),
            'rtk_sources': str(rtk_sources_topic),
            'rtk_source_status': str(rtk_source_status_topic),
            'rtk_source_select': str(rtk_source_select_topic),
            'rtk_source_manage': str(rtk_source_manage_topic),
            'velocity': str(velocity_topic),
            'odom': str(odom_topic),
        }

        if not html_path:
            share_dir = Path(get_package_share_directory('sensores'))
            html_path = str(share_dir / 'pixhawk_dashboard.html')

        self._html_content = self._load_html(html_path)
        self._data_lock = threading.Lock()
        self._data = {
            'imu': None,
            'gps': None,
            'gps_meta': {
                'fix_type': None,
                'fix_type_name': None,
                'rtk_status': None,
                'rtcm_age_s': None,
                'rtcm_received_count': None,
            },
            'rtk_sources': [],
            'rtk_source_state': None,
            'velocity': None,
            'odom': None,
            'topics': dict(self._topic_bindings),
            'diagnostics': {'yaw_delta_deg': None},
        }
        self._ws_clients = set()
        self._ws_loop = None
        self._ws_server = None
        self._ws_stop_event = None

        self.create_subscription(
            Imu, imu_topic, self._imu_cb, qos_profile_sensor_data
        )
        self.create_subscription(
            NavSatFix, gps_topic, self._gps_cb, qos_profile_sensor_data
        )
        self.create_subscription(
            Int32, fix_type_topic, self._fix_type_cb, 10
        )
        self.create_subscription(
            GPSRAW, gps_raw_topic, self._gps_raw_cb, qos_profile_sensor_data
        )
        self.create_subscription(
            String, rtk_status_topic, self._rtk_status_cb, 10
        )
        self.create_subscription(
            Float32, rtcm_age_topic, self._rtcm_age_cb, 10
        )
        self.create_subscription(
            Int32, rtcm_count_topic, self._rtcm_count_cb, 10
        )
        self.create_subscription(
            String, rtk_sources_topic, self._rtk_sources_cb, 10
        )
        self.create_subscription(
            String, rtk_source_status_topic, self._rtk_source_status_cb, 10
        )
        self.create_subscription(
            TwistStamped, velocity_topic, self._velocity_cb, qos_profile_sensor_data
        )
        self.create_subscription(
            Odometry, odom_topic, self._odom_cb, qos_profile_sensor_data
        )
        self._rtk_source_select_pub = self.create_publisher(
            String, rtk_source_select_topic, 10
        )
        self._rtk_source_manage_pub = self.create_publisher(
            String, rtk_source_manage_topic, 10
        )

        self._httpd = self._start_http_server(http_host, int(http_port))
        self.get_logger().info(
            f'Web server running at http://{http_host}:{http_port}'
        )

        self._start_ws_server(ws_host, int(ws_port))
        self.get_logger().info(
            f'WebSocket server running at ws://{ws_host}:{ws_port}/ws'
        )
        self.get_logger().info(
            'Dashboard topic bindings: '
            f"imu={self._topic_bindings['imu']}, "
            f"gps={self._topic_bindings['gps']}, "
            f"fix_type={self._topic_bindings['fix_type']}, "
            f"rtk_status={self._topic_bindings['rtk_status']}, "
            f"rtcm_age={self._topic_bindings['rtcm_age']}, "
            f"rtcm_count={self._topic_bindings['rtcm_count']}, "
            f"gps_raw={self._topic_bindings['gps_raw']}, "
            f"velocity={self._topic_bindings['velocity']}, "
            f"odom={self._topic_bindings['odom']}"
        )

    def _load_html(self, html_path: str) -> str:
        try:
            return Path(html_path).read_text(encoding='utf-8')
        except Exception as exc:
            self.get_logger().error(f'Failed to read HTML: {exc}')
            return '<html><body>Missing HTML file.</body></html>'

    def _start_http_server(self, host: str, port: int) -> ThreadingHTTPServer:
        node = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path in ('/', '/index.html'):
                    self._send_response(200, 'text/html', node._html_content)
                    return
                if self.path.startswith('/data'):
                    payload = node._get_snapshot()
                    self._send_response(200, 'application/json', payload)
                    return
                if self.path.startswith('/rtk/sources'):
                    payload = node._get_rtk_sources_snapshot()
                    self._send_response(200, 'application/json', payload)
                    return
                if self.path.startswith('/rtk/status'):
                    payload = node._get_rtk_source_status_snapshot()
                    self._send_response(200, 'application/json', payload)
                    return
                self._send_response(404, 'text/plain', 'Not Found')

            def do_POST(self):  # noqa: N802
                if self.path == '/rtk/sources':
                    content_length = int(self.headers.get('Content-Length', '0'))
                    try:
                        raw_body = self.rfile.read(content_length).decode('utf-8')
                        body = json.loads(raw_body or '{}')
                    except Exception:
                        self._send_response(
                            400,
                            'application/json',
                            json.dumps({'ok': False, 'error': 'invalid_json'}),
                        )
                        return

                    result = node._upsert_rtk_source(body)
                    status_code = 200 if result.get('ok') else 400
                    self._send_response(
                        status_code,
                        'application/json',
                        json.dumps(result),
                    )
                    return

                if self.path.startswith('/rtk/source'):
                    content_length = int(self.headers.get('Content-Length', '0'))
                    try:
                        raw_body = self.rfile.read(content_length).decode('utf-8')
                        body = json.loads(raw_body or '{}')
                    except Exception:
                        self._send_response(
                            400,
                            'application/json',
                            json.dumps({'ok': False, 'error': 'invalid_json'}),
                        )
                        return

                    source_id = str(body.get('id') or '').strip()
                    if not source_id:
                        self._send_response(
                            400,
                            'application/json',
                            json.dumps({'ok': False, 'error': 'missing_id'}),
                        )
                        return

                    result = node._request_rtk_source(source_id)
                    status_code = 200 if result.get('ok') else 400
                    self._send_response(
                        status_code,
                        'application/json',
                        json.dumps(result),
                    )
                    return

                self._send_response(404, 'text/plain', 'Not Found')

            def do_DELETE(self):  # noqa: N802
                prefix = '/rtk/sources/'
                if self.path.startswith(prefix):
                    source_id = self.path[len(prefix):].strip().strip('/')
                    result = node._delete_rtk_source(source_id)
                    status_code = 200 if result.get('ok') else 400
                    self._send_response(
                        status_code,
                        'application/json',
                        json.dumps(result),
                    )
                    return

                self._send_response(404, 'text/plain', 'Not Found')

            def do_OPTIONS(self):  # noqa: N802
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.end_headers()

            def _send_response(self, code, content_type, body):
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

    def _get_snapshot(self) -> str:
        with self._data_lock:
            return json.dumps(self._data)

    def _get_rtk_sources_snapshot(self) -> str:
        with self._data_lock:
            return json.dumps({'sources': list(self._data.get('rtk_sources') or [])})

    def _get_rtk_source_status_snapshot(self) -> str:
        with self._data_lock:
            return json.dumps(self._data.get('rtk_source_state') or {})

    def _request_rtk_source(self, source_id: str) -> dict:
        try:
            msg = String()
            msg.data = source_id
            self._rtk_source_select_pub.publish(msg)
            with self._data_lock:
                current_state = dict(self._data.get('rtk_source_state') or {})
            current_state['requested_source_id'] = source_id
            return {'ok': True, 'requested_source_id': source_id, 'state': current_state}
        except Exception as exc:
            self.get_logger().error(f'Failed to request RTK source {source_id}: {exc}')
            return {'ok': False, 'error': str(exc), 'requested_source_id': source_id}

    def _upsert_rtk_source(self, body: dict) -> dict:
        try:
            source_id = str(body.get('id') or '').strip()
            if not source_id:
                return {'ok': False, 'error': 'missing_id'}

            payload = {
                'action': 'upsert',
                'id': source_id,
            }
            for key in ('label', 'host', 'port', 'mountpoint', 'username', 'password'):
                if key in body:
                    payload[key] = body.get(key)
            if 'activate' in body:
                payload['activate'] = bool(body.get('activate'))

            msg = String()
            msg.data = json.dumps(payload)
            self._rtk_source_manage_pub.publish(msg)
            return {'ok': True, 'requested_action': 'upsert', 'requested_source': payload}
        except Exception as exc:
            self.get_logger().error(f'Failed to upsert RTK source: {exc}')
            return {'ok': False, 'error': str(exc)}

    def _delete_rtk_source(self, source_id: str) -> dict:
        source_id = str(source_id or '').strip()
        if not source_id:
            return {'ok': False, 'error': 'missing_id'}
        try:
            msg = String()
            msg.data = json.dumps({'action': 'delete', 'id': source_id})
            self._rtk_source_manage_pub.publish(msg)
            return {'ok': True, 'requested_action': 'delete', 'requested_source_id': source_id}
        except Exception as exc:
            self.get_logger().error(f'Failed to delete RTK source {source_id}: {exc}')
            return {'ok': False, 'error': str(exc), 'requested_source_id': source_id}

    def _start_ws_server(self, host: str, port: int):
        self._ws_loop = asyncio.new_event_loop()
        thread = threading.Thread(
            target=self._run_ws_loop, args=(host, port), daemon=True
        )
        thread.start()

    def _run_ws_loop(self, host: str, port: int):
        asyncio.set_event_loop(self._ws_loop)
        self._ws_stop_event = asyncio.Event()
        self._ws_loop.run_until_complete(self._ws_main(host, port))
        self._ws_loop.close()

    async def _ws_main(self, host: str, port: int):
        async with websockets.serve(self._ws_handler, host, port):
            self._ws_loop.create_task(self._ws_broadcast())
            await self._ws_stop_event.wait()

    async def _ws_handler(self, websocket):
        self._ws_clients.add(websocket)
        try:
            async for _ in websocket:
                pass
        finally:
            self._ws_clients.discard(websocket)

    async def _ws_broadcast(self):
        while True:
            payload = self._get_snapshot()
            if self._ws_clients:
                stale = []
                for ws in list(self._ws_clients):
                    try:
                        await ws.send(payload)
                    except Exception:
                        stale.append(ws)
                for ws in stale:
                    self._ws_clients.discard(ws)
            await asyncio.sleep(0.25)

    def _imu_cb(self, msg: Imu):
        yaw_enu_rad, yaw_enu_deg = _yaw_enu_from_quaternion(
            msg.orientation.x,
            msg.orientation.y,
            msg.orientation.z,
            msg.orientation.w,
        )
        data = {
            'stamp': _stamp_to_float(msg.header.stamp),
            'frame_id': msg.header.frame_id,
            'orientation': {
                'x': msg.orientation.x,
                'y': msg.orientation.y,
                'z': msg.orientation.z,
                'w': msg.orientation.w,
            },
            'yaw_enu_rad': yaw_enu_rad,
            'yaw_enu_deg': yaw_enu_deg,
            'angular_velocity': {
                'x': msg.angular_velocity.x,
                'y': msg.angular_velocity.y,
                'z': msg.angular_velocity.z,
            },
            'linear_acceleration': {
                'x': msg.linear_acceleration.x,
                'y': msg.linear_acceleration.y,
                'z': msg.linear_acceleration.z,
            },
        }
        with self._data_lock:
            self._data['imu'] = data
            self._update_diagnostics_locked()

    def _gps_cb(self, msg: NavSatFix):
        data = {
            'stamp': _stamp_to_float(msg.header.stamp),
            'frame_id': msg.header.frame_id,
            'status': int(msg.status.status),
            'service': int(msg.status.service),
            'latitude': msg.latitude,
            'longitude': msg.longitude,
            'altitude': msg.altitude,
            'position_covariance': list(msg.position_covariance),
            'position_covariance_type': int(msg.position_covariance_type),
        }
        with self._data_lock:
            self._data['gps'] = data

    def _fix_type_cb(self, msg: Int32):
        fix_type = int(msg.data)
        with self._data_lock:
            self._data['gps_meta']['fix_type'] = fix_type
            self._data['gps_meta']['fix_type_name'] = FIX_TYPE_NAMES.get(
                fix_type, 'UNKNOWN'
            )

    def _gps_raw_cb(self, msg: GPSRAW):
        fix_type = int(msg.fix_type)
        with self._data_lock:
            self._data['gps_meta']['fix_type'] = fix_type
            self._data['gps_meta']['fix_type_name'] = FIX_TYPE_NAMES.get(
                fix_type, 'UNKNOWN'
            )
            self._data['gps_meta']['satellites_visible'] = int(msg.satellites_visible)
            self._data['gps_meta']['eph'] = int(msg.eph)
            self._data['gps_meta']['epv'] = int(msg.epv)

    def _rtk_status_cb(self, msg: String):
        with self._data_lock:
            self._data['gps_meta']['rtk_status'] = str(msg.data)

    def _rtcm_age_cb(self, msg: Float32):
        with self._data_lock:
            self._data['gps_meta']['rtcm_age_s'] = float(msg.data)

    def _rtcm_count_cb(self, msg: Int32):
        with self._data_lock:
            self._data['gps_meta']['rtcm_received_count'] = int(msg.data)

    def _rtk_sources_cb(self, msg: String):
        try:
            payload = json.loads(str(msg.data))
            sources = payload.get('sources') or []
            if not isinstance(sources, list):
                return
        except Exception:
            return

        normalized = []
        for source in sources:
            if not isinstance(source, dict):
                continue
            normalized.append(
                {
                    'id': str(source.get('id') or ''),
                    'label': str(source.get('label') or source.get('id') or ''),
                    'host': str(source.get('host') or ''),
                    'port': source.get('port'),
                    'mountpoint': str(source.get('mountpoint') or ''),
                }
            )

        with self._data_lock:
            self._data['rtk_sources'] = normalized

    def _rtk_source_status_cb(self, msg: String):
        try:
            payload = json.loads(str(msg.data))
            if not isinstance(payload, dict):
                return
        except Exception:
            return

        with self._data_lock:
            self._data['rtk_source_state'] = payload

    def _velocity_cb(self, msg: TwistStamped):
        data = {
            'stamp': _stamp_to_float(msg.header.stamp),
            'frame_id': msg.header.frame_id,
            'linear': {
                'x': msg.twist.linear.x,
                'y': msg.twist.linear.y,
                'z': msg.twist.linear.z,
            },
            'angular': {
                'x': msg.twist.angular.x,
                'y': msg.twist.angular.y,
                'z': msg.twist.angular.z,
            },
        }
        with self._data_lock:
            self._data['velocity'] = data

    def _odom_cb(self, msg: Odometry):
        yaw_enu_rad, yaw_enu_deg = _yaw_enu_from_quaternion(
            msg.pose.pose.orientation.x,
            msg.pose.pose.orientation.y,
            msg.pose.pose.orientation.z,
            msg.pose.pose.orientation.w,
        )
        data = {
            'stamp': _stamp_to_float(msg.header.stamp),
            'frame_id': msg.header.frame_id,
            'child_frame_id': msg.child_frame_id,
            'position': {
                'x': msg.pose.pose.position.x,
                'y': msg.pose.pose.position.y,
                'z': msg.pose.pose.position.z,
            },
            'orientation': {
                'x': msg.pose.pose.orientation.x,
                'y': msg.pose.pose.orientation.y,
                'z': msg.pose.pose.orientation.z,
                'w': msg.pose.pose.orientation.w,
            },
            'yaw_enu_rad': yaw_enu_rad,
            'yaw_enu_deg': yaw_enu_deg,
            'linear': {
                'x': msg.twist.twist.linear.x,
                'y': msg.twist.twist.linear.y,
                'z': msg.twist.twist.linear.z,
            },
            'angular': {
                'x': msg.twist.twist.angular.x,
                'y': msg.twist.twist.angular.y,
                'z': msg.twist.twist.angular.z,
            },
        }
        with self._data_lock:
            self._data['odom'] = data
            self._update_diagnostics_locked()

    def _update_diagnostics_locked(self):
        imu = self._data.get('imu') or {}
        odom = self._data.get('odom') or {}

        imu_yaw_rad = imu.get('yaw_enu_rad')
        odom_yaw_rad = odom.get('yaw_enu_rad')
        yaw_delta_deg = None

        if isinstance(imu_yaw_rad, (int, float)) and isinstance(odom_yaw_rad, (int, float)):
            if math.isfinite(float(imu_yaw_rad)) and math.isfinite(float(odom_yaw_rad)):
                delta_rad = _normalize_angle_rad(float(imu_yaw_rad) - float(odom_yaw_rad))
                yaw_delta_deg = math.degrees(delta_rad)

        self._data['diagnostics']['yaw_delta_deg'] = yaw_delta_deg

    def destroy_node(self):
        if hasattr(self, '_httpd') and self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
        if self._ws_loop is not None:
            if self._ws_stop_event is not None:
                self._ws_loop.call_soon_threadsafe(self._ws_stop_event.set)
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = PixhawkWebServer()
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

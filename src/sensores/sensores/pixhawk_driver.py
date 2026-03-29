#!/usr/bin/env python3
"""
pixhawk_driver.py — ROS 2 node: Pixhawk (ArduPilot) MAVLink ↔ RTK GPS + IMU + Odometry

Publishes:
  - /imu/data              (sensor_msgs/Imu)      : accel+gyro from SCALED_IMU2, orientation from ATTITUDE_QUATERNION
  - /gps/fix              (sensor_msgs/NavSatFix) : GNSS position from GPS_RAW_INT with dynamic covariance
  - /gps/rtk_status       (std_msgs/String)       : Fix type name (NO_GPS, 3D_FIX, RTK_FLOAT, RTK_FIXED, etc)
  - /gps/fix_type         (std_msgs/Int32)        : fix_type raw value (0-6)
  - /gps/satellites_visible (std_msgs/Int32)      : Number of satellites in view
  - /gps/hdop             (std_msgs/Float32)      : Horizontal dilution of precision
  - /gps/rtcm_age_s       (std_msgs/Float32)      : Time since last RTCM received (seconds)
  - /gps/rtcm_received_count (std_msgs/Int32)     : Total RTCM messages received
  - /gps/rtcm_sequence_id (std_msgs/Int32)        : Last RTCM sequence ID sent to Pixhawk
  - /odom                 (nav_msgs/Odometry)     : EKF pose+twist from LOCAL_POSITION_NED + attitude
  - /velocity             (geometry_msgs/TwistStamped) : twist in base_link frame

Subscribes:
  - /rtcm                 (rtcm_msgs/Message or UInt8MultiArray) : NTRIP RTCM corrections

Coordinate Frames (ROS standard):
  - odom_frame:      ENU world frame (x=E, y=N, z=Up)
  - base_link_frame: FLU body frame (x=Forward, y=Left, z=Up)

ArduPilot conventions: world=NED, body=FRD (converted to ENU/FLU here).

RTK Features:
  - Automatic RTCM fragmentation (max 720 bytes per message)
  - GPS_RTCM_DATA MAVLink message with correct flags & sequence ID
  - Detects RTCM loss and GPS loss
  - Dynamic covariance based on fix_type (NO_GPS → RTK_FIXED)
  - Detects fix_type transitions (e.g., 3D → RTK_FLOAT)
  - Reads GPS_RTK optional message if available
  - TCP RTCM client with automatic reconnection
"""

from __future__ import annotations

import math
import queue
import time
import threading
import socket
from typing import Optional, Tuple
from dataclasses import dataclass

import rclpy
from rclpy.node import Node

from sensor_msgs.msg import Imu, NavSatFix, NavSatStatus
from geometry_msgs.msg import TwistStamped, Quaternion, Vector3
from nav_msgs.msg import Odometry
from std_msgs.msg import Header, String, Int32, Float32

from pymavlink import mavutil


# ============================================================================
# Constants
# ============================================================================

# TCP RTCM Client
RTCM_TCP_HOST = '127.0.0.1'
RTCM_TCP_PORT = 2102
RTCM_TCP_RECONNECT_INTERVAL = 2.0  # seconds
RTCM_TCP_READ_TIMEOUT = 1.0  # seconds
RTCM_TCP_BUFFER_SIZE = 4096

# RTCM Fragmentation
RTCM_FRAG_MAX_BYTES = 180  # GPS_RTCM_DATA payload size per fragment
RTCM_MAX_FRAGMENTS = 4
RTCM_MAX_BYTES_TOTAL = RTCM_FRAG_MAX_BYTES * RTCM_MAX_FRAGMENTS  # 720 bytes

# Position covariance by fix_type (horizontal, in meters²)
# Vertical = horizontal * 4.0
COV_BY_FIX_TYPE = {
    0: 9999.0,      # NO_GPS
    1: 9999.0,      # NO_FIX
    2: 9999.0,      # 2D_FIX
    3: 9.0,         # 3D_FIX (≈3m std)
    4: 0.25,        # DGPS (≈0.5m std)
    5: 0.09,        # RTK_FLOAT (≈0.3m std)
    6: 0.0004,      # RTK_FIXED (≈0.02m std = 2cm)
}

# Fix type names for logging
FIX_TYPE_NAMES = {
    0: 'NO_GPS',
    1: 'NO_FIX',
    2: '2D_FIX',
    3: '3D_FIX',
    4: 'DGPS',
    5: 'RTK_FLOAT',
    6: 'RTK_FIXED',
}


# ============================================================================
# Math helpers (no numpy needed)
# ============================================================================

def quat_norm(q: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    """Normalize quaternion (w, x, y, z) to unit magnitude; return identity if norm is zero."""
    w, x, y, z = q
    n = math.sqrt(w*w + x*x + y*y + z*z)
    if n == 0.0:
        return (1.0, 0.0, 0.0, 0.0)
    return (w/n, x/n, y/n, z/n)

def quat_mul(q1, q2):
    """Hamilton product. Quaternions are (w,x,y,z)."""
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return (
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2,
    )

def quat_conj(q):
    """Return conjugate of quaternion (w, x, y, z), negating vector parts."""
    w, x, y, z = q
    return (w, -x, -y, -z)

def quat_from_yaw(yaw_rad: float) -> Tuple[float, float, float, float]:
    """Build quaternion (w, x, y, z) for a pure yaw rotation around +Z."""
    half = 0.5 * float(yaw_rad)
    return (math.cos(half), 0.0, 0.0, math.sin(half))

def yaw_deg_from_quat(q: Tuple[float, float, float, float]) -> float:
    """Extract ENU yaw from quaternion (w, x, y, z) and return degrees in [-180, 180]."""
    w, x, y, z = quat_norm(q)
    siny_cosp = 2.0 * ((w * z) + (x * y))
    cosy_cosp = 1.0 - (2.0 * ((y * y) + (z * z)))
    yaw_deg = math.degrees(math.atan2(siny_cosp, cosy_cosp))
    while yaw_deg <= -180.0:
        yaw_deg += 360.0
    while yaw_deg > 180.0:
        yaw_deg -= 360.0
    return yaw_deg

def rotvec_by_quat(v: Tuple[float, float, float], q: Tuple[float, float, float, float]) -> Tuple[float, float, float]:
    """Rotate vector v by quaternion q (active rotation)."""
    q = quat_norm(q)
    vx, vy, vz = v
    vq = (0.0, vx, vy, vz)
    rq = quat_mul(quat_mul(q, vq), quat_conj(q))
    return (rq[1], rq[2], rq[3])

def ros_quat_from_tuple(q) -> Quaternion:
    """Convert tuple (w, x, y, z) to ROS2 geometry_msgs/Quaternion."""
    w, x, y, z = q
    out = Quaternion()
    out.w, out.x, out.y, out.z = w, x, y, z
    return out


# ============================================================================
# Frame transforms
# ============================================================================

# NED → ENU for vectors: [xE, yN, zU] = [y, x, -z]
def vec_ned_to_enu(v_ned: Tuple[float, float, float]) -> Tuple[float, float, float]:
    """Convert vector from NED (North-East-Down) to ENU (East-North-Up)."""
    xN, yE, zD = v_ned
    return (yE, xN, -zD)

# FRD → FLU for body vectors: [xF, yL, zU] = [x, -y, -z]
def vec_frd_to_flu(v_frd: Tuple[float, float, float]) -> Tuple[float, float, float]:
    """Convert vector from FRD (Forward-Right-Down) to FLU (Forward-Left-Up)."""
    xF, yR, zD = v_frd
    return (xF, -yR, -zD)

def quat_from_rotation_matrix(R) -> Tuple[float, float, float, float]:
    """Convert 3x3 rotation matrix to quaternion (w,x,y,z)."""
    r00, r01, r02 = R[0]
    r10, r11, r12 = R[1]
    r20, r21, r22 = R[2]
    tr = r00 + r11 + r22
    if tr > 0.0:
        S = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * S
        x = (r21 - r12) / S
        y = (r02 - r20) / S
        z = (r10 - r01) / S
    elif (r00 > r11) and (r00 > r22):
        S = math.sqrt(1.0 + r00 - r11 - r22) * 2.0
        w = (r21 - r12) / S
        x = 0.25 * S
        y = (r01 + r10) / S
        z = (r02 + r20) / S
    elif r11 > r22:
        S = math.sqrt(1.0 + r11 - r00 - r22) * 2.0
        w = (r02 - r20) / S
        x = (r01 + r10) / S
        y = 0.25 * S
        z = (r12 + r21) / S
    else:
        S = math.sqrt(1.0 + r22 - r00 - r11) * 2.0
        w = (r10 - r01) / S
        x = (r02 + r20) / S
        y = (r12 + r21) / S
        z = 0.25 * S
    return quat_norm((w, x, y, z))

def rotation_matrix_from_quat(q: Tuple[float, float, float, float]):
    """Convert quaternion (w, x, y, z) to 3x3 rotation matrix."""
    w, x, y, z = quat_norm(q)
    return [
        [1-2*(y*y+z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
        [2*(x*y + z*w), 1-2*(x*x+z*z), 2*(y*z - x*w)],
        [2*(x*z - y*w), 2*(y*z + x*w), 1-2*(x*x+y*y)],
    ]

def mat_mul(A, B):
    """Multiply two 3x3 matrices."""
    out = [[0.0]*3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            out[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j]
    return out

def transpose(A):
    """Return transpose of 3x3 matrix."""
    return [[A[j][i] for j in range(3)] for i in range(3)]

def quat_ned_frd_to_enu_flu(q_ned_frd: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    """Convert rotation from body(FRD)→world(NED) into body(FLU)→world(ENU)."""
    T_world = [
        [0.0, 1.0, 0.0],  # ENU = T_world * NED
        [1.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
    ]
    T_body = [
        [1.0, 0.0, 0.0],   # FLU = T_body * FRD
        [0.0, -1.0, 0.0],
        [0.0, 0.0, -1.0],
    ]
    R_ned_frd = rotation_matrix_from_quat(q_ned_frd)
    R_enu_flu = mat_mul(mat_mul(T_world, R_ned_frd), transpose(T_body))
    return quat_from_rotation_matrix(R_enu_flu)


# ============================================================================
# Data classes for state tracking
# ============================================================================

@dataclass
class RTCMState:
    """Tracks RTCM reception and transmission state."""
    last_receive_time: float = 0.0
    received_count: int = 0
    last_sequence_id: int = -1  # -1 = not sent yet
    bytes_last_second: int = 0
    errors: int = 0


@dataclass
class GPSState:
    """Tracks GPS fix state and transitions."""
    last_fix_type: int = -1
    last_fix_time: float = 0.0
    fix_type_changed: bool = False
    degradation_detected: bool = False
    last_sats: int = 0


@dataclass
class MavTxCommand:
    """Queued MAVLink TX command processed only from the main I/O loop."""
    kind: str
    payload: object


# ============================================================================
# ROS 2 Node
# ============================================================================

class PixhawkMavlinkNode(Node):
    """ROS 2 node: Pixhawk MAVLink driver with RTK support."""

    def __init__(self):
        super().__init__('pixhawk_driver')

        # ====== Parameters ======
        self.declare_parameter('serial_port', '/dev/ttyACM0')
        self.declare_parameter('baudrate', 921600)
        self.declare_parameter('odom_frame', 'odom')
        self.declare_parameter('base_link_frame', 'base_footprint')
        self.declare_parameter('imu_frame', 'imu_link')
        self.declare_parameter('gps_frame', 'gps_link')
        self.declare_parameter('publish_rate_hz', 200.0)
        self.declare_parameter('enable_gps_rtk', True)  # Try to read GPS_RTK message
        self.declare_parameter('enable_rtcm_tcp', True)
        self.declare_parameter('rtcm_tcp_host', RTCM_TCP_HOST)
        self.declare_parameter('rtcm_tcp_port', RTCM_TCP_PORT)
        self.declare_parameter('rtcm_topic', '/rtcm')
        self.declare_parameter('yaw_correction_deg', 0.0)

        port = self.get_parameter('serial_port').value
        baud = int(self.get_parameter('baudrate').value)

        self.odom_frame = self.get_parameter('odom_frame').value
        self.base_link_frame = self.get_parameter('base_link_frame').value
        self.imu_frame = self.get_parameter('imu_frame').value
        self.gps_frame = self.get_parameter('gps_frame').value
        self.enable_gps_rtk = self.get_parameter('enable_gps_rtk').value
        self.enable_rtcm_tcp = bool(self.get_parameter('enable_rtcm_tcp').value)
        self.rtcm_tcp_host = str(self.get_parameter('rtcm_tcp_host').value)
        self.rtcm_tcp_port = int(self.get_parameter('rtcm_tcp_port').value)
        self.rtcm_topic = str(self.get_parameter('rtcm_topic').value)
        self.yaw_correction_deg = float(self.get_parameter('yaw_correction_deg').value)
        self.yaw_correction_rad = math.radians(self.yaw_correction_deg)
        self._yaw_correction_quat = quat_from_yaw(self.yaw_correction_rad)
        self.get_logger().info(
            'Yaw correction configured '
            f'(yaw_correction_deg={self.yaw_correction_deg:.2f}, '
            f'rad={self.yaw_correction_rad:.6f})'
        )

        # ====== Publishers ======
        self.pub_imu = self.create_publisher(Imu, '/imu/data', 20)
        self.pub_gps = self.create_publisher(NavSatFix, '/gps/fix', 10)
        self.pub_odom = self.create_publisher(Odometry, '/odom', 20)
        self.pub_vel = self.create_publisher(TwistStamped, '/velocity', 20)

        # Diagnostic publishers
        self.pub_rtk_status = self.create_publisher(String, '/gps/rtk_status', 5)
        self.pub_fix_type = self.create_publisher(Int32, '/gps/fix_type', 5)
        self.pub_sats_visible = self.create_publisher(Int32, '/gps/satellites_visible', 5)
        self.pub_hdop = self.create_publisher(Float32, '/gps/hdop', 5)
        self.pub_rtcm_age = self.create_publisher(Float32, '/gps/rtcm_age_s', 2)
        self.pub_rtcm_count = self.create_publisher(Int32, '/gps/rtcm_received_count', 2)
        self.pub_rtcm_seq_id = self.create_publisher(Int32, '/gps/rtcm_sequence_id', 2)

        # ====== State ======
        self._lock = threading.Lock()

        # IMU/AHRS state
        self._last_accel_flu: Optional[Tuple[float, float, float]] = None
        self._last_gyro_flu: Optional[Tuple[float, float, float]] = None
        self._last_orientation_enu_flu: Optional[Tuple[float, float, float, float]] = None

        # Odometry state
        self._last_pos_enu: Optional[Tuple[float, float, float]] = None
        self._last_vel_enu: Optional[Tuple[float, float, float]] = None
        self._last_angvel_flu: Optional[Tuple[float, float, float]] = None

        # GPS/RTK state
        self._gps_state = GPSState()
        self._rtcm_state = RTCMState()
        self._mav_tx_queue: "queue.SimpleQueue[MavTxCommand]" = queue.SimpleQueue()
        self._rtcm_sub = None

        # ====== MAVLink connection ======
        self.get_logger().info(f'Connecting MAVLink on {port} @ {baud}...')
        self.mav = mavutil.mavlink_connection(
            port,
            baud=baud,
            source_system=255,
            source_component=0,
            autoreconnect=True,
        )

        self.get_logger().info('Waiting for heartbeat...')
        hb = self.mav.wait_heartbeat(timeout=10)
        if hb is None:
            raise RuntimeError('No heartbeat from Pixhawk (timeout). Check port/baud/cable.')

        self.get_logger().info(
            f'Heartbeat OK (sys={self.mav.target_system}, comp={self.mav.target_component})'
        )

        # Queue initial message-rate requests so all MAVLink writes go through the main loop.
        self._enqueue_message_rate_request('ATTITUDE_QUATERNION', 50)
        self._enqueue_message_rate_request('SCALED_IMU2', 100)
        self._enqueue_message_rate_request('SCALED_IMU', 100)
        self._enqueue_message_rate_request('LOCAL_POSITION_NED', 50)
        self._enqueue_message_rate_request('GPS_RAW_INT', 10)
        if self.enable_gps_rtk:
            self._enqueue_message_rate_request('GPS_RTK', 5)

        rtcm_msg_type = self._detect_rtcm_msg_type()
        if rtcm_msg_type is not None:
            self._rtcm_sub = self.create_subscription(
                rtcm_msg_type, self.rtcm_topic, self._rtcm_callback, 10
            )
            self.get_logger().info(
                f'RTCM ROS subscription enabled on {self.rtcm_topic}'
            )
        else:
            self.get_logger().info(
                'RTCM ROS subscription disabled (no supported RTCM message type found)'
            )

        # ====== TCP RTCM Client ======
        self._tcp_sock: Optional[socket.socket] = None
        self._tcp_running = True
        self._tcp_connected = False
        self._tcp_last_connect_attempt = 0.0
        self._tcp_thread: Optional[threading.Thread] = None

        # Start TCP reader thread
        if self.enable_rtcm_tcp:
            self._tcp_thread = threading.Thread(target=self._tcp_reader_loop, daemon=True)
            self._tcp_thread.start()
            self.get_logger().info(
                f'RTCM TCP client started (connecting to {self.rtcm_tcp_host}:{self.rtcm_tcp_port})'
            )
        else:
            self.get_logger().info('RTCM TCP client disabled by parameter')

        # ====== Main loop timer ======
        tick = 1.0 / float(self.get_parameter('publish_rate_hz').value)
        self.create_timer(tick, self._spin_once)

        # Diagnostics timer (once per second)
        self.create_timer(1.0, self._publish_diagnostics)

        self.get_logger().info('Node initialized.')

    def _detect_rtcm_msg_type(self):
        """Detect RTCM message type dynamically."""
        msg_types = []

        # Try rtcm_msgs.Message
        try:
            from rtcm_msgs.msg import Message as RTCMMessage
            msg_types.append(RTCMMessage)
        except ImportError:
            pass

        # Try mavros_msgs.RTCM
        try:
            from mavros_msgs.msg import RTCM
            msg_types.append(RTCM)
        except ImportError:
            pass

        # Try std_msgs.ByteMultiArray or UInt8MultiArray
        try:
            from std_msgs.msg import UInt8MultiArray
            msg_types.append(UInt8MultiArray)
        except ImportError:
            pass

        if msg_types:
            return msg_types[0]
        return None

    def _extract_rtcm_bytes(self, msg) -> Optional[bytes]:
        """Extract RTCM bytes from message (handles different message types)."""
        # Try different field names depending on message type
        for field_name in ['message', 'buf', 'data']:
            if hasattr(msg, field_name):
                field = getattr(msg, field_name)
                if isinstance(field, (bytes, bytearray)):
                    return bytes(field)
                elif isinstance(field, list):
                    return bytes(field)
        return None

    def _decode_rtcm_flags(self, flags: int) -> dict:
        """Decode GPS_RTCM_DATA flags for logging."""
        fragmented = bool(flags & 0x01)
        frag_id = (flags >> 1) & 0x03
        seq_id = (flags >> 3) & 0x1F
        return {
            'fragmented': fragmented,
            'frag_id': frag_id,
            'seq_id': seq_id,
        }

    def _enqueue_message_rate_request(self, msg_name: str, hz: float) -> None:
        """Queue a MAVLink message-rate request to be sent from the main I/O loop."""
        self._mav_tx_queue.put(MavTxCommand('set_rate', (msg_name, float(hz))))

    def _enqueue_rtcm(self, rtcm_data: bytes) -> None:
        """Queue RTCM bytes so the main I/O loop can forward them to Pixhawk."""
        self._mav_tx_queue.put(MavTxCommand('rtcm', bytes(rtcm_data)))

    def _drain_mav_tx_queue(self, max_items: int = 64) -> None:
        """Send queued MAVLink writes from the single main-loop owner of the serial link."""
        for _ in range(max_items):
            try:
                item = self._mav_tx_queue.get_nowait()
            except queue.Empty:
                break

            if item.kind == 'rtcm':
                self._send_rtcm_to_pixhawk(item.payload)
            elif item.kind == 'set_rate':
                msg_name, hz = item.payload
                self._set_message_rate(msg_name, hz)
            else:
                self.get_logger().warning(f'Unknown MAVLink TX command kind: {item.kind}')

    def _send_rtcm_to_pixhawk(self, rtcm_data: bytes):
        """
        Fragment RTCM data and send to Pixhawk via GPS_RTCM_DATA.

        Raises ValueError if message is too large (> 720 bytes).
        """
        if len(rtcm_data) == 0:
            self.get_logger().warn('Received empty RTCM message, ignoring.')
            return

        if len(rtcm_data) > RTCM_MAX_BYTES_TOTAL:
            self.get_logger().error(
                f'RTCM message too large: {len(rtcm_data)} bytes (max {RTCM_MAX_BYTES_TOTAL}). '
                f'Would require {(len(rtcm_data) + RTCM_FRAG_MAX_BYTES - 1) // RTCM_FRAG_MAX_BYTES} fragments. Rejecting.'
            )
            with self._lock:
                self._rtcm_state.errors += 1
            return

        # Increment sequence ID (5-bit, wraps at 32)
        with self._lock:
            self._rtcm_state.last_sequence_id = (self._rtcm_state.last_sequence_id + 1) & 0x1F

        seq_id = self._rtcm_state.last_sequence_id

        # Fragment the message
        num_frags = (len(rtcm_data) + RTCM_FRAG_MAX_BYTES - 1) // RTCM_FRAG_MAX_BYTES

        self.get_logger().info(
            f'RTCM: {len(rtcm_data)} bytes → {num_frags} fragment(s), seq_id={seq_id}'
        )

        for frag_id in range(num_frags):
            start = frag_id * RTCM_FRAG_MAX_BYTES
            end = min(start + RTCM_FRAG_MAX_BYTES, len(rtcm_data))
            frag_data = rtcm_data[start:end]
            frag_len = len(frag_data)

            # Build flags
            flags = 0
            if num_frags > 1:
                flags |= 0x01  # fragmented bit
            flags |= (frag_id & 0x03) << 1  # fragment ID (bits 1-2)
            flags |= (seq_id & 0x1F) << 3   # sequence ID (bits 3-7)

            # Pad fragment to 180 bytes
            frag_padded = bytearray(RTCM_FRAG_MAX_BYTES)
            frag_padded[:frag_len] = frag_data

            # Send to Pixhawk
            try:
                self.mav.mav.gps_rtcm_data_send(
                    flags,
                    frag_len,
                    list(frag_padded),
                )
                decoded_flags = self._decode_rtcm_flags(flags)
                self.get_logger().debug(
                    f'Sent fragment {frag_id+1}/{num_frags}: '
                    f'{frag_len} bytes, flags={flags:02x} '
                    f'(frag_id={decoded_flags["frag_id"]}, seq_id={decoded_flags["seq_id"]})'
                )
            except Exception as e:
                self.get_logger().error(f'Failed to send RTCM fragment: {e}')
                with self._lock:
                    self._rtcm_state.errors += 1

    def _tcp_connect(self) -> bool:
        """Try to connect to TCP RTCM server. Returns True if connected."""
        try:
            self._tcp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._tcp_sock.settimeout(RTCM_TCP_READ_TIMEOUT)
            self._tcp_sock.connect((self.rtcm_tcp_host, self.rtcm_tcp_port))
            self._tcp_connected = True
            self.get_logger().info(
                f'Connected to RTCM TCP server at {self.rtcm_tcp_host}:{self.rtcm_tcp_port}'
            )
            return True
        except Exception as e:
            self._tcp_connected = False
            if self._tcp_sock is not None:
                try:
                    self._tcp_sock.close()
                except:
                    pass
            self._tcp_sock = None
            return False

    def _tcp_disconnect(self):
        """Close TCP connection."""
        if self._tcp_sock is not None:
            try:
                self._tcp_sock.close()
            except:
                pass
            self._tcp_sock = None
        self._tcp_connected = False

    def _tcp_reader_loop(self):
        """
        Background thread: read RTCM data from TCP and send to Pixhawk.
        Implements automatic reconnection.
        """
        rtcm_buffer = bytearray()

        while self._tcp_running:
            # Try to connect if not connected
            if not self._tcp_connected:
                now = time.time()
                if now - self._tcp_last_connect_attempt > RTCM_TCP_RECONNECT_INTERVAL:
                    self._tcp_last_connect_attempt = now
                    if self._tcp_connect():
                        pass  # Connected
                    else:
                        self.get_logger().debug(
                            f'Failed to connect to RTCM TCP. Retrying in {RTCM_TCP_RECONNECT_INTERVAL}s'
                        )
                time.sleep(0.1)
                continue

            # Read from socket
            try:
                data = self._tcp_sock.recv(RTCM_TCP_BUFFER_SIZE)
                if not data:
                    self.get_logger().warn('RTCM TCP connection closed by server')
                    self._tcp_disconnect()
                    continue

                rtcm_buffer.extend(data)

                # Try to extract and send complete RTCM messages
                # RTCM messages start with 0xD3 and have length in bytes 1-2
                while len(rtcm_buffer) >= 6:
                    if rtcm_buffer[0] != 0xD3:
                        # Sync error: skip byte
                        rtcm_buffer.pop(0)
                        continue

                    # Extract RTCM message length (10 bits at bytes 1-2)
                    length = ((rtcm_buffer[1] & 0x03) << 8) | rtcm_buffer[2]
                    length += 6  # Include preamble (1) + length field (2) + CRC (3)

                    if len(rtcm_buffer) < length:
                        break  # Wait for more data

                    # Extract complete RTCM message
                    rtcm_msg = bytes(rtcm_buffer[:length])
                    rtcm_buffer = rtcm_buffer[length:]

                    # Send to Pixhawk
                    now = time.time()
                    with self._lock:
                        self._rtcm_state.last_receive_time = now
                        self._rtcm_state.received_count += 1
                        self._rtcm_state.bytes_last_second += len(rtcm_msg)

                    self._enqueue_rtcm(rtcm_msg)

            except socket.timeout:
                # No data available, continue
                pass
            except ConnectionResetError:
                self.get_logger().warn('RTCM TCP connection lost (reset)')
                self._tcp_disconnect()
            except Exception as e:
                self.get_logger().error(f'RTCM TCP read error: {e}')
                self._tcp_disconnect()

    def _rtcm_callback(self, msg):
        """Callback for /rtcm subscription (kept for backwards compatibility)."""
        rtcm_data = self._extract_rtcm_bytes(msg)
        if rtcm_data is None:
            self.get_logger().warn('Could not extract RTCM bytes from message.')
            return

        # Update state
        now = time.time()
        with self._lock:
            self._rtcm_state.last_receive_time = now
            self._rtcm_state.received_count += 1
            self._rtcm_state.bytes_last_second += len(rtcm_data)

        # Queue for the main MAVLink loop.
        self._enqueue_rtcm(rtcm_data)

    def _set_message_rate(self, msg_name: str, hz: float):
        """Set MAVLink message rate via MAV_CMD_SET_MESSAGE_INTERVAL."""
        try:
            msg_id = getattr(mavutil.mavlink, f'MAVLINK_MSG_ID_{msg_name}')
        except AttributeError:
            return

        interval_us = int(1e6 / hz) if hz > 0 else 0
        self.mav.mav.command_long_send(
            self.mav.target_system,
            self.mav.target_component,
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
            0,
            msg_id,
            interval_us,
            0, 0, 0, 0, 0
        )

    def _spin_once(self):
        """Main MAVLink message loop (called by timer every ~5ms at 200Hz)."""
        self._drain_mav_tx_queue()

        for _ in range(50):
            msg = self.mav.recv_match(blocking=False)
            if msg is None:
                break

            t = msg.get_type()
            if t in ('SCALED_IMU2', 'SCALED_IMU'):
                self._handle_scaled_imu(msg)
            elif t == 'ATTITUDE_QUATERNION':
                self._handle_attitude_quaternion(msg)
            elif t == 'LOCAL_POSITION_NED':
                self._handle_local_position_ned(msg)
            elif t == 'GPS_RAW_INT':
                self._handle_gps_raw_int(msg)
            elif t == 'GPS_RTK' and self.enable_gps_rtk:
                self._handle_gps_rtk(msg)

        # Publish combined outputs
        self._publish_imu_if_ready()
        self._publish_odom_if_ready()

    def _handle_scaled_imu(self, msg):
        """Process SCALED_IMU/SCALED_IMU2 message."""
        # mg → m/s², mrad/s → rad/s
        ax_frd = (msg.xacc / 1000.0) * 9.80665
        ay_frd = (msg.yacc / 1000.0) * 9.80665
        az_frd = (msg.zacc / 1000.0) * 9.80665

        gx_frd = msg.xgyro / 1000.0
        gy_frd = msg.ygyro / 1000.0
        gz_frd = msg.zgyro / 1000.0

        # FRD → FLU
        self._last_accel_flu = vec_frd_to_flu((ax_frd, ay_frd, az_frd))
        self._last_gyro_flu = vec_frd_to_flu((gx_frd, gy_frd, gz_frd))

    def _handle_attitude_quaternion(self, msg):
        """Process ATTITUDE_QUATERNION message."""
        q_ned_frd = quat_norm((msg.q1, msg.q2, msg.q3, msg.q4))
        q_enu_flu = quat_ned_frd_to_enu_flu(q_ned_frd)
        # Apply a global yaw correction in ENU to compensate fixed mounting offsets.
        q_enu_flu = quat_norm(quat_mul(self._yaw_correction_quat, q_enu_flu))
        self._last_orientation_enu_flu = q_enu_flu

        # Body angular rates (FRD → FLU)
        self._last_angvel_flu = vec_frd_to_flu((msg.rollspeed, msg.pitchspeed, msg.yawspeed))

    def _handle_local_position_ned(self, msg):
        """Process LOCAL_POSITION_NED message."""
        pos_ned = (msg.x, msg.y, msg.z)
        vel_ned = (msg.vx, msg.vy, msg.vz)

        self._last_pos_enu = vec_ned_to_enu(pos_ned)
        self._last_vel_enu = vec_ned_to_enu(vel_ned)

    def _handle_gps_raw_int(self, msg):
        """
        Process GPS_RAW_INT message.
        - Extracts position, covarianceand fix info
        - Detects fix_type transitions
        - Publishes /gps/fix with dynamic covariance
        """
        # Validate coordinates
        lat = msg.lat / 1e7
        lon = msg.lon / 1e7
        alt = msg.alt / 1000.0

        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self.get_logger().warn(f'Invalid GPS coordinates: lat={lat}, lon={lon}')
            return

        fix_type = msg.fix_type
        sats = msg.satellites_visible
        hdop_raw = getattr(msg, 'eph', 65535)  # Horizontal error in cm
        hdop = (hdop_raw / 100.0) if hdop_raw != 65535 else 10.0

        # Detect fix_type changes
        if fix_type != self._gps_state.last_fix_type:
            old_fix = self._gps_state.last_fix_type
            old_name = FIX_TYPE_NAMES.get(old_fix, '?')
            new_name = FIX_TYPE_NAMES.get(fix_type, '?')

            if old_fix >= 0:
                # This is a transition, not the first fix
                if fix_type < old_fix:
                    self._gps_state.degradation_detected = True
                    self.get_logger().warn(
                        f'GPS fix degraded: {old_name} → {new_name}'
                    )
                else:
                    self._gps_state.degradation_detected = False
                    self.get_logger().info(
                        f'GPS fix improved: {old_name} → {new_name}'
                    )

            self._gps_state.last_fix_type = fix_type
            self._gps_state.fix_type_changed = True
        else:
            self._gps_state.fix_type_changed = False

        # Build NavSatFix message
        gps = NavSatFix()
        gps.header.stamp = self.get_clock().now().to_msg()
        gps.header.frame_id = self.gps_frame

        gps.latitude = lat
        gps.longitude = lon
        gps.altitude = alt

        # Status
        if fix_type >= 5:
            gps.status.status = NavSatStatus.STATUS_GBAS_FIX
        elif fix_type >= 3:
            gps.status.status = NavSatStatus.STATUS_FIX
        else:
            gps.status.status = NavSatStatus.STATUS_NO_FIX
        gps.status.service = NavSatStatus.SERVICE_GPS

        # Dynamic covariance based on fix_type
        cov_h = COV_BY_FIX_TYPE.get(fix_type, 9999.0)
        cov_v = cov_h * 4.0

        gps.position_covariance = [
            cov_h, 0.0,  0.0,
            0.0,  cov_h, 0.0,
            0.0,  0.0,  cov_v
        ]
        gps.position_covariance_type = NavSatFix.COVARIANCE_TYPE_DIAGONAL_KNOWN

        self.pub_gps.publish(gps)

        # Publish fix_type and related diagnostics
        msg_fix_type = Int32()
        msg_fix_type.data = fix_type
        self.pub_fix_type.publish(msg_fix_type)

        msg_sats = Int32()
        msg_sats.data = sats
        self.pub_sats_visible.publish(msg_sats)

        msg_hdop = Float32()
        msg_hdop.data = hdop
        self.pub_hdop.publish(msg_hdop)

        # Publish RTK status
        status_name = FIX_TYPE_NAMES.get(fix_type, 'UNKNOWN')
        msg_status = String()
        msg_status.data = f'{status_name} ({sats} sats, hdop={hdop:.1f})'
        self.pub_rtk_status.publish(msg_status)

        self._gps_state.last_sats = sats
        self._gps_state.last_fix_time = time.time()

        # Print GPS data once per second
        now = time.time()
        if not hasattr(self, '_last_gps_print') or now - self._last_gps_print >= 1.0:
            self._last_gps_print = now
            yaw_text = "N/A"
            if self._last_orientation_enu_flu is not None:
                yaw_text = f"{yaw_deg_from_quat(self._last_orientation_enu_flu):.1f}"
            self.get_logger().info(
                f'[GPS] {status_name} | sats={sats} | '
                f'lat={lat:.7f} lon={lon:.7f} alt={alt:.2f}m | '
                f'acc={hdop:.2f}m | '
                f'yaw_enu_deg={yaw_text}'
            )

    def _handle_gps_rtk(self, msg):
        """
        Process optional GPS_RTK message for additional RTK diagnostics.
        Available on some ArduPilot versions.
        """
        # GPS_RTK has: wn, tow, rtk_receiver_status, rtk_rate, rtk_health_flags, rtk_num_satellites
        # Use for additional diagnostics if needed
        pass

    def _publish_imu_if_ready(self):
        """Publish IMU message when acceleration, gyro, and orientation are available."""
        if self._last_accel_flu is None or self._last_gyro_flu is None:
            return

        imu = Imu()
        imu.header.stamp = self.get_clock().now().to_msg()
        imu.header.frame_id = self.imu_frame

        ax, ay, az = self._last_accel_flu
        gx, gy, gz = self._last_gyro_flu

        imu.linear_acceleration.x = ax
        imu.linear_acceleration.y = ay
        imu.linear_acceleration.z = az

        imu.angular_velocity.x = gx
        imu.angular_velocity.y = gy
        imu.angular_velocity.z = gz

        if self._last_orientation_enu_flu is not None:
            imu.orientation = ros_quat_from_tuple(self._last_orientation_enu_flu)
            imu.orientation_covariance = [
                0.01, 0.0,  0.0,
                0.0,  0.01, 0.0,
                0.0,  0.0,  0.01
            ]
        else:
            imu.orientation_covariance[0] = -1.0

        imu.angular_velocity_covariance = [
            0.001, 0.0,   0.0,
            0.0,   0.001, 0.0,
            0.0,   0.0,   0.001
        ]
        imu.linear_acceleration_covariance = [
            0.02, 0.0,  0.0,
            0.0,  0.02, 0.0,
            0.0,  0.0,  0.02
        ]

        self.pub_imu.publish(imu)

    def _publish_odom_if_ready(self):
        """Publish Odometry and TwistStamped messages."""
        if self._last_pos_enu is None or self._last_vel_enu is None:
            return

        odom = Odometry()
        odom.header.stamp = self.get_clock().now().to_msg()
        odom.header.frame_id = self.odom_frame
        odom.child_frame_id = self.base_link_frame

        px, py, pz = self._last_pos_enu
        odom.pose.pose.position.x = px
        odom.pose.pose.position.y = py
        odom.pose.pose.position.z = pz

        if self._last_orientation_enu_flu is not None:
            odom.pose.pose.orientation = ros_quat_from_tuple(self._last_orientation_enu_flu)
        else:
            odom.pose.pose.orientation.w = 1.0

        # Twist: linear velocity in base_link
        vx_e, vy_n, vz_u = self._last_vel_enu
        if self._last_orientation_enu_flu is not None:
            q = self._last_orientation_enu_flu
            v_body = rotvec_by_quat((vx_e, vy_n, vz_u), quat_conj(q))
            odom.twist.twist.linear.x = v_body[0]
            odom.twist.twist.linear.y = v_body[1]
            odom.twist.twist.linear.z = v_body[2]
        else:
            odom.twist.twist.linear.x = vx_e
            odom.twist.twist.linear.y = vy_n
            odom.twist.twist.linear.z = vz_u

        if self._last_angvel_flu is not None:
            wx, wy, wz = self._last_angvel_flu
            odom.twist.twist.angular.x = wx
            odom.twist.twist.angular.y = wy
            odom.twist.twist.angular.z = wz

        self.pub_odom.publish(odom)

        vel = TwistStamped()
        vel.header = odom.header
        vel.header.frame_id = self.base_link_frame
        vel.twist = odom.twist.twist
        self.pub_vel.publish(vel)

    def _publish_diagnostics(self):
        """Publish diagnostic information (called once per second)."""
        with self._lock:
            now = time.time()
            rtcm_age = now - self._rtcm_state.last_receive_time if self._rtcm_state.last_receive_time > 0 else 999.0

            # Check for RTCM loss
            if rtcm_age > 5.0 and self._rtcm_state.received_count > 0:
                self.get_logger().warn(
                    f'RTCM loss detected: {rtcm_age:.1f}s since last message '
                    f'({self._rtcm_state.received_count} total received)'
                )

            # Check for GPS loss
            gps_age = now - self._gps_state.last_fix_time
            if gps_age > 2.0 and self._gps_state.last_fix_time > 0:
                self.get_logger().warn(f'GPS loss detected: {gps_age:.1f}s since last fix')

            # Publish RTCM diagnostics
            msg_age = Float32()
            msg_age.data = min(rtcm_age, 999.0)
            self.pub_rtcm_age.publish(msg_age)

            msg_count = Int32()
            msg_count.data = self._rtcm_state.received_count
            self.pub_rtcm_count.publish(msg_count)

            msg_seq = Int32()
            msg_seq.data = max(0, self._rtcm_state.last_sequence_id)
            self.pub_rtcm_seq_id.publish(msg_seq)

            # Reset byte counter
            self._rtcm_state.bytes_last_second = 0

    def destroy_node(self):
        """Clean shutdown."""
        self.get_logger().info('Shutting down...')
        # Stop TCP reader thread
        self._tcp_running = False
        if self._tcp_thread is not None and self._tcp_thread.is_alive():
            self._tcp_thread.join(timeout=2.0)
        # Close TCP connection
        self._tcp_disconnect()
        super().destroy_node()


# ============================================================================
# Main
# ============================================================================

def main(args=None):
    """ROS 2 entry point."""
    rclpy.init(args=args)
    node = None
    try:
        node = PixhawkMavlinkNode()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        if node:
            node.get_logger().error(f'Fatal error: {e}', exc_info=True)
    finally:
        if node is not None:
            node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

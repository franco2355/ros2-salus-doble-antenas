#!/usr/bin/env python3

import socket
import threading
import time
from dataclasses import dataclass
from typing import Optional

import rclpy
from mavros_msgs.msg import RTCM, RTKBaseline
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import NavSatFix, NavSatStatus
from std_msgs.msg import Float32, Int32, String, UInt8MultiArray

RTCM_TCP_HOST = "127.0.0.1"
RTCM_TCP_PORT = 2102
RTCM_TCP_RECONNECT_INTERVAL = 2.0
RTCM_TCP_READ_TIMEOUT = 1.0
RTCM_TCP_BUFFER_SIZE = 4096
RTCM_MIN_FRAME_BYTES = 6


@dataclass
class RTCMState:
    last_receive_time_s: Optional[float] = None
    received_count: int = 0
    last_message_size: int = 0
    tcp_connected: bool = False


class RtkBridgeNode(Node):
    def __init__(self) -> None:
        super().__init__("rtk_bridge")

        self.declare_parameter("enable_rtcm_tcp", True)
        self.declare_parameter("rtcm_tcp_host", RTCM_TCP_HOST)
        self.declare_parameter("rtcm_tcp_port", RTCM_TCP_PORT)
        self.declare_parameter("rtcm_topic", "/rtcm")
        self.declare_parameter("send_rtcm_topic", "/mavros_node/send_rtcm")
        self.declare_parameter("gps_topic", "/global_position/raw/fix")
        self.declare_parameter("rtk_baseline_topic", "/mavros_node/rtk_baseline")
        self.declare_parameter("diagnostics_period_s", 1.0)
        self.declare_parameter("rtcm_stale_timeout_s", 5.0)
        self.declare_parameter("tcp_retry_log_period_s", 30.0)

        self.enable_rtcm_tcp = bool(self.get_parameter("enable_rtcm_tcp").value)
        self.rtcm_tcp_host = str(self.get_parameter("rtcm_tcp_host").value)
        self.rtcm_tcp_port = int(self.get_parameter("rtcm_tcp_port").value)
        self.rtcm_topic = str(self.get_parameter("rtcm_topic").value)
        self.send_rtcm_topic = str(self.get_parameter("send_rtcm_topic").value)
        self.gps_topic = str(self.get_parameter("gps_topic").value)
        self.rtk_baseline_topic = str(self.get_parameter("rtk_baseline_topic").value)
        self._diagnostics_period_s = float(
            self.get_parameter("diagnostics_period_s").value
        )
        self._rtcm_stale_timeout_s = float(
            self.get_parameter("rtcm_stale_timeout_s").value
        )
        self._tcp_retry_log_period_s = float(
            self.get_parameter("tcp_retry_log_period_s").value
        )

        self._rtcm_pub = self.create_publisher(RTCM, self.send_rtcm_topic, 10)
        self._status_pub = self.create_publisher(String, "/gps/rtk_status", 2)
        self._rtcm_age_pub = self.create_publisher(Float32, "/gps/rtcm_age_s", 2)
        self._rtcm_count_pub = self.create_publisher(Int32, "/gps/rtcm_received_count", 2)

        self.create_subscription(
            NavSatFix, self.gps_topic, self._gps_cb, qos_profile_sensor_data
        )
        self.create_subscription(
            RTKBaseline,
            self.rtk_baseline_topic,
            self._rtk_baseline_cb,
            qos_profile_sensor_data,
        )
        self._create_rtcm_subscriptions()
        self.create_timer(self._diagnostics_period_s, self._publish_diagnostics)

        self._stop_event = threading.Event()
        self._tcp_sock: Optional[socket.socket] = None
        self._tcp_thread: Optional[threading.Thread] = None
        self._tcp_last_connect_attempt_s = 0.0
        self._last_gps_msg: Optional[NavSatFix] = None
        self._last_rtk_baseline: Optional[RTKBaseline] = None
        self._rtcm_state = RTCMState()
        self._missing_mavros_logged = False
        self._rtcm_stale_logged = False
        self._last_tcp_retry_log_s = 0.0

        if self.enable_rtcm_tcp:
            self._tcp_thread = threading.Thread(
                target=self._tcp_reader_loop, name="rtcm_tcp_reader", daemon=True
            )
            self._tcp_thread.start()

        self.get_logger().info(
            "RTK bridge active: "
            f"{self.rtcm_topic} + TCP({self.rtcm_tcp_host}:{self.rtcm_tcp_port}) -> "
            f"{self.send_rtcm_topic} | GPS diagnostics from {self.gps_topic} "
            f"| baseline topic {self.rtk_baseline_topic}"
        )

    def destroy_node(self) -> bool:
        self._stop_event.set()
        self._close_tcp_socket()
        if self._tcp_thread and self._tcp_thread.is_alive():
            self._tcp_thread.join(timeout=2.0)
        return super().destroy_node()

    def _create_rtcm_subscriptions(self) -> None:
        self._rtcm_subscriptions = []

        try:
            from rtcm_msgs.msg import Message as RTCMMessage

            self._rtcm_subscriptions.append(
                self.create_subscription(
                    RTCMMessage,
                    self.rtcm_topic,
                    lambda msg: self._rtcm_callback(msg, "rtcm_msgs/Message"),
                    10,
                )
            )
        except ImportError:
            pass

        self._rtcm_subscriptions.append(
            self.create_subscription(
                RTCM,
                self.rtcm_topic,
                lambda msg: self._rtcm_callback(msg, "mavros_msgs/RTCM"),
                10,
            )
        )

        self._rtcm_subscriptions.append(
            self.create_subscription(
                UInt8MultiArray,
                self.rtcm_topic,
                lambda msg: self._rtcm_callback(msg, "std_msgs/UInt8MultiArray"),
                10,
            )
        )

        self.get_logger().info(
            f"RTK bridge listening for RTCM on {self.rtcm_topic} "
            "with support for rtcm_msgs/Message, mavros_msgs/RTCM and UInt8MultiArray"
        )

    def _now_s(self) -> float:
        return self.get_clock().now().nanoseconds / 1e9

    def _gps_cb(self, msg: NavSatFix) -> None:
        self._last_gps_msg = msg

    def _rtk_baseline_cb(self, msg: RTKBaseline) -> None:
        self._last_rtk_baseline = msg

    def _rtcm_callback(self, msg, source: str) -> None:
        rtcm_data = self._extract_rtcm_bytes(msg)
        if rtcm_data is None:
            self.get_logger().warning(
                f"Could not extract RTCM bytes from {source} on {self.rtcm_topic}"
            )
            return
        self._forward_rtcm(rtcm_data, source)

    def _extract_rtcm_bytes(self, msg) -> Optional[bytes]:
        for field_name in ["message", "buf", "data"]:
            if not hasattr(msg, field_name):
                continue
            field = getattr(msg, field_name)
            if isinstance(field, (bytes, bytearray)):
                return bytes(field)
            try:
                return bytes(field)
            except TypeError:
                continue
        return None

    def _forward_rtcm(self, rtcm_data: bytes, source: str) -> None:
        if not rtcm_data:
            self.get_logger().warning(f"Ignoring empty RTCM payload from {source}")
            return

        self._rtcm_state.last_receive_time_s = self._now_s()
        self._rtcm_state.received_count += 1
        self._rtcm_state.last_message_size = len(rtcm_data)

        consumer_count = self._rtcm_consumer_count()
        if consumer_count == 0 and not self._missing_mavros_logged:
            self.get_logger().warning(
                "No subscriber detected for RTCM forwarding topic "
                f"{self.send_rtcm_topic}. Check MAVROS gps_rtk plugin allowlist."
            )
            self._missing_mavros_logged = True
        elif consumer_count > 0 and self._missing_mavros_logged:
            self.get_logger().info(
                f"MAVROS gps_rtk consumer detected on {self.send_rtcm_topic}"
            )
            self._missing_mavros_logged = False

        msg = RTCM()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.data = list(rtcm_data)
        self._rtcm_pub.publish(msg)

    def _tcp_connect(self) -> bool:
        self._close_tcp_socket()
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(RTCM_TCP_READ_TIMEOUT)
            sock.connect((self.rtcm_tcp_host, self.rtcm_tcp_port))
            self._tcp_sock = sock
            self._rtcm_state.tcp_connected = True
            self._last_tcp_retry_log_s = 0.0
            self.get_logger().info(
                f"Connected to RTCM TCP source at {self.rtcm_tcp_host}:{self.rtcm_tcp_port}"
            )
            return True
        except OSError as exc:
            self._rtcm_state.tcp_connected = False
            now = time.monotonic()
            if (now - self._last_tcp_retry_log_s) >= self._tcp_retry_log_period_s:
                self.get_logger().info(
                    "RTCM TCP source unavailable at "
                    f"{self.rtcm_tcp_host}:{self.rtcm_tcp_port}: {exc}. "
                    "The bridge will keep retrying in background."
                )
                self._last_tcp_retry_log_s = now
            self._close_tcp_socket()
            return False

    def _close_tcp_socket(self) -> None:
        sock = self._tcp_sock
        self._tcp_sock = None
        self._rtcm_state.tcp_connected = False
        if sock is None:
            return
        try:
            sock.close()
        except OSError:
            pass

    def _tcp_reader_loop(self) -> None:
        buffer = bytearray()
        while not self._stop_event.is_set():
            if self._tcp_sock is None:
                now = time.monotonic()
                if (now - self._tcp_last_connect_attempt_s) >= RTCM_TCP_RECONNECT_INTERVAL:
                    self._tcp_last_connect_attempt_s = now
                    self._tcp_connect()
                time.sleep(0.1)
                continue

            try:
                data = self._tcp_sock.recv(RTCM_TCP_BUFFER_SIZE)
                if not data:
                    self.get_logger().warning("RTCM TCP connection closed by peer")
                    self._close_tcp_socket()
                    continue
                buffer.extend(data)
                self._consume_rtcm_stream(buffer)
            except socket.timeout:
                continue
            except OSError as exc:
                self.get_logger().warning(f"RTCM TCP read error: {exc}")
                self._close_tcp_socket()

    def _consume_rtcm_stream(self, buffer: bytearray) -> None:
        while len(buffer) >= RTCM_MIN_FRAME_BYTES:
            if buffer[0] != 0xD3:
                buffer.pop(0)
                continue

            payload_length = ((buffer[1] & 0x03) << 8) | buffer[2]
            frame_length = payload_length + RTCM_MIN_FRAME_BYTES
            if len(buffer) < frame_length:
                return

            rtcm_msg = bytes(buffer[:frame_length])
            del buffer[:frame_length]
            self._forward_rtcm(rtcm_msg, "tcp")

    def _rtcm_consumer_count(self) -> int:
        try:
            return self._rtcm_pub.get_subscription_count()
        except AttributeError:
            return self.count_subscribers(self.send_rtcm_topic)

    def _status_text(self, rtcm_age: float) -> str:
        if self._rtcm_consumer_count() == 0:
            return "waiting_for_mavros_gps_rtk"
        if self._last_gps_msg is None:
            return "waiting_for_gps"
        if (
            self._last_rtk_baseline is not None
            and self._last_gps_msg.status.status >= NavSatStatus.STATUS_GBAS_FIX
        ):
            return "rtk_fix"
        if self._last_gps_msg.status.status == NavSatStatus.STATUS_NO_FIX:
            return "gps_no_fix"
        if self._last_gps_msg.status.status == NavSatStatus.STATUS_GBAS_FIX:
            return "rtk_fix"
        if self._rtcm_state.received_count == 0:
            return "gps_only"
        if rtcm_age > self._rtcm_stale_timeout_s:
            return "rtcm_stale"
        return "rtcm_ok"

    def _publish_diagnostics(self) -> None:
        now_s = self._now_s()
        if self._rtcm_state.last_receive_time_s is None:
            rtcm_age = 999.0
        else:
            rtcm_age = max(0.0, now_s - self._rtcm_state.last_receive_time_s)

        if self._rtcm_state.received_count > 0 and rtcm_age > self._rtcm_stale_timeout_s:
            if not self._rtcm_stale_logged:
                self.get_logger().warning(
                    f"RTCM stale: {rtcm_age:.1f}s since last correction"
                )
                self._rtcm_stale_logged = True
        elif self._rtcm_stale_logged:
            self.get_logger().info("RTCM stream resumed")
            self._rtcm_stale_logged = False

        msg_status = String()
        msg_status.data = self._status_text(rtcm_age)
        self._status_pub.publish(msg_status)

        msg_age = Float32()
        msg_age.data = min(rtcm_age, 999.0)
        self._rtcm_age_pub.publish(msg_age)

        msg_count = Int32()
        msg_count.data = self._rtcm_state.received_count
        self._rtcm_count_pub.publish(msg_count)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = RtkBridgeNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()

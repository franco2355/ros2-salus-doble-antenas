from __future__ import annotations

import math
from typing import Any, Optional

import rclpy
from geographic_msgs.msg import GeoPoint
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix


class MapGpsAbsoluteMeasurementNode(Node):
    def __init__(self) -> None:
        super().__init__("map_gps_absolute_measurement")

        self.declare_parameter("gps_topic", "/gps/fix")
        self.declare_parameter("output_topic", "/gps/odometry_map")
        self.declare_parameter("map_frame", "map")
        self.declare_parameter("pose_covariance_xy", 0.05)
        self.declare_parameter("fromll_service", "/fromLL")
        self.declare_parameter("fromll_service_fallback", "/navsat_transform/fromLL")
        self.declare_parameter("fromll_wait_timeout_s", 0.2)

        self.gps_topic = str(self.get_parameter("gps_topic").value)
        self.output_topic = str(self.get_parameter("output_topic").value)
        self.map_frame = str(self.get_parameter("map_frame").value).strip() or "map"
        self.pose_covariance_xy = max(
            1.0e-9, float(self.get_parameter("pose_covariance_xy").value)
        )
        self.fromll_service = str(self.get_parameter("fromll_service").value)
        self.fromll_service_fallback = str(
            self.get_parameter("fromll_service_fallback").value
        )
        self.fromll_wait_timeout_s = max(
            0.01, float(self.get_parameter("fromll_wait_timeout_s").value)
        )

        self._odom_pub = self.create_publisher(Odometry, self.output_topic, 10)
        self._fromll_client = self.create_client(FromLL, self.fromll_service)
        self._fromll_fallback_client = None
        if self.fromll_service_fallback and (
            self.fromll_service_fallback != self.fromll_service
        ):
            self._fromll_fallback_client = self.create_client(
                FromLL, self.fromll_service_fallback
            )

        self._active_fromll_client: Optional[Any] = None
        self._active_fromll_name: Optional[str] = None
        self._pending_future: Optional[Any] = None
        self._pending_fix: Optional[NavSatFix] = None
        self._queued_fix: Optional[NavSatFix] = None

        self.create_subscription(
            NavSatFix,
            self.gps_topic,
            self._on_gps_fix,
            qos_profile_sensor_data,
        )

        self.get_logger().info(
            "map_gps_absolute_measurement ready "
            f"(gps={self.gps_topic}, output={self.output_topic}, "
            f"fromLL={self.fromll_service}, fallback={self.fromll_service_fallback}, "
            f"map_frame={self.map_frame}, cov_xy={self.pose_covariance_xy:.6f})"
        )

    @staticmethod
    def _is_valid_fix(msg: NavSatFix) -> bool:
        return (
            math.isfinite(float(msg.latitude))
            and math.isfinite(float(msg.longitude))
            and math.isfinite(float(msg.altitude))
            and (-90.0 <= float(msg.latitude) <= 90.0)
            and (-180.0 <= float(msg.longitude) <= 180.0)
        )

    @staticmethod
    def _build_odometry_message(
        fix_msg: NavSatFix,
        *,
        map_frame: str,
        pose_covariance_xy: float,
        map_x: float,
        map_y: float,
        map_z: float,
    ) -> Odometry:
        msg = Odometry()
        msg.header = fix_msg.header
        msg.header.frame_id = str(map_frame)
        msg.child_frame_id = ""
        msg.pose.pose.position.x = float(map_x)
        msg.pose.pose.position.y = float(map_y)
        msg.pose.pose.position.z = float(map_z)
        msg.pose.pose.orientation.w = 1.0

        pose_covariance = [0.0] * 36
        for index in (0, 7, 14, 21, 28, 35):
            pose_covariance[index] = 1.0e6
        pose_covariance[0] = float(pose_covariance_xy)
        pose_covariance[7] = float(pose_covariance_xy)
        msg.pose.covariance = pose_covariance

        twist_covariance = [0.0] * 36
        for index in (0, 7, 14, 21, 28, 35):
            twist_covariance[index] = 1.0e6
        msg.twist.covariance = twist_covariance
        return msg

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        if not self._is_valid_fix(msg):
            return

        if self._pending_future is not None:
            self._queued_fix = msg
            return

        self._request_fromll_for_fix(msg)

    def _resolve_fromll_client(self) -> Optional[Any]:
        candidates = []
        if self._active_fromll_client is not None and self._active_fromll_name is not None:
            candidates.append((self._active_fromll_client, self._active_fromll_name, 0.05))
        candidates.append((self._fromll_client, self.fromll_service, self.fromll_wait_timeout_s))
        if self._fromll_fallback_client is not None:
            candidates.append(
                (
                    self._fromll_fallback_client,
                    self.fromll_service_fallback,
                    self.fromll_wait_timeout_s,
                )
            )

        seen = set()
        for client, service_name, wait_s in candidates:
            key = (id(client), service_name)
            if key in seen:
                continue
            seen.add(key)
            if client.wait_for_service(timeout_sec=wait_s):
                self._active_fromll_client = client
                if self._active_fromll_name != service_name:
                    self._active_fromll_name = service_name
                    self.get_logger().info(f"Using fromLL service: {service_name}")
                return client

        self.get_logger().warning(
            "fromLL service unavailable "
            f"(tried '{self.fromll_service}'"
            + (
                f" and '{self.fromll_service_fallback}'"
                if self._fromll_fallback_client is not None
                else ""
            )
            + ")"
        )
        return None

    @staticmethod
    def _make_fromll_request(msg: NavSatFix) -> FromLL.Request:
        request = FromLL.Request()
        request.ll_point = GeoPoint(
            latitude=float(msg.latitude),
            longitude=float(msg.longitude),
            altitude=float(msg.altitude),
        )
        return request

    def _request_fromll_for_fix(self, msg: NavSatFix) -> None:
        client = self._resolve_fromll_client()
        if client is None:
            return

        future = client.call_async(self._make_fromll_request(msg))
        self._pending_future = future
        self._pending_fix = msg
        future.add_done_callback(self._on_fromll_done)

    def _handle_fromll_result(self, fix_msg: NavSatFix, response: Any) -> None:
        map_point = response.map_point
        if not (
            math.isfinite(float(map_point.x))
            and math.isfinite(float(map_point.y))
            and math.isfinite(float(map_point.z))
        ):
            self.get_logger().warning("Ignoring invalid fromLL response with non-finite map point")
            return

        self._odom_pub.publish(
            self._build_odometry_message(
                fix_msg,
                map_frame=self.map_frame,
                pose_covariance_xy=self.pose_covariance_xy,
                map_x=float(map_point.x),
                map_y=float(map_point.y),
                map_z=float(map_point.z),
            )
        )

    def _on_fromll_done(self, future: Any) -> None:
        pending_fix = self._pending_fix
        self._pending_future = None
        self._pending_fix = None

        try:
            response = future.result()
        except Exception as exc:
            self.get_logger().warning(f"fromLL request failed: {exc}")
            response = None

        if response is not None and pending_fix is not None:
            self._handle_fromll_result(pending_fix, response)

        queued_fix = self._queued_fix
        self._queued_fix = None
        if queued_fix is not None:
            self._request_fromll_for_fix(queued_fix)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = MapGpsAbsoluteMeasurementNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

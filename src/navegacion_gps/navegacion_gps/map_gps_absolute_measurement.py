from __future__ import annotations

import math
from typing import Any, Optional

import rclpy
from geographic_msgs.msg import GeoPoint
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from robot_localization.srv import FromLL
from sensor_msgs.msg import NavSatFix
from tf2_ros import Buffer, TransformException, TransformListener


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
        self.declare_parameter("base_frame", "base_footprint")
        self.declare_parameter("odom_topic", "/odometry/local")
        self.declare_parameter("gps_frame_id_fallback", "gps_link")

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
        self.base_frame = str(self.get_parameter("base_frame").value).strip() or "base_footprint"
        self.odom_topic = str(self.get_parameter("odom_topic").value).strip() or "/odometry/local"
        self.gps_frame_id_fallback = (
            str(self.get_parameter("gps_frame_id_fallback").value).strip() or "gps_link"
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
        self._latest_base_yaw_rad: Optional[float] = None
        self._gps_mount_offsets_xy: dict[str, tuple[float, float]] = {}
        self._missing_gps_tf_warned: set[str] = set()
        self._missing_base_yaw_warned = False
        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self, spin_thread=False)

        self.create_subscription(
            NavSatFix,
            self.gps_topic,
            self._on_gps_fix,
            qos_profile_sensor_data,
        )
        self.create_subscription(
            Odometry,
            self.odom_topic,
            self._on_odometry,
            10,
        )

        self.get_logger().info(
            "map_gps_absolute_measurement ready "
            f"(gps={self.gps_topic}, output={self.output_topic}, "
            f"fromLL={self.fromll_service}, fallback={self.fromll_service_fallback}, "
            f"map_frame={self.map_frame}, base_frame={self.base_frame}, "
            f"odom_topic={self.odom_topic}, cov_xy={self.pose_covariance_xy:.6f})"
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
    def _yaw_from_quaternion_xyzw(x: float, y: float, z: float, w: float) -> float:
        siny_cosp = 2.0 * ((float(w) * float(z)) + (float(x) * float(y)))
        cosy_cosp = 1.0 - 2.0 * ((float(y) * float(y)) + (float(z) * float(z)))
        return math.atan2(siny_cosp, cosy_cosp)

    @staticmethod
    def _apply_base_to_gps_offset(
        *,
        map_x: float,
        map_y: float,
        base_yaw_rad: float,
        base_to_gps_x: float,
        base_to_gps_y: float,
    ) -> tuple[float, float]:
        cos_yaw = math.cos(float(base_yaw_rad))
        sin_yaw = math.sin(float(base_yaw_rad))
        gps_offset_x_map = (cos_yaw * float(base_to_gps_x)) - (
            sin_yaw * float(base_to_gps_y)
        )
        gps_offset_y_map = (sin_yaw * float(base_to_gps_x)) + (
            cos_yaw * float(base_to_gps_y)
        )
        return (
            float(map_x) - gps_offset_x_map,
            float(map_y) - gps_offset_y_map,
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

    def _on_odometry(self, msg: Odometry) -> None:
        orientation = msg.pose.pose.orientation
        self._latest_base_yaw_rad = self._yaw_from_quaternion_xyzw(
            orientation.x,
            orientation.y,
            orientation.z,
            orientation.w,
        )

    def _gps_frame_candidates(self, fix_msg: NavSatFix) -> list[str]:
        candidates: list[str] = []
        msg_frame_id = str(fix_msg.header.frame_id).strip()
        if msg_frame_id:
            candidates.append(msg_frame_id)
        if self.gps_frame_id_fallback and self.gps_frame_id_fallback not in candidates:
            candidates.append(self.gps_frame_id_fallback)
        return candidates

    def _lookup_gps_mount_offset_xy(self, fix_msg: NavSatFix) -> Optional[tuple[float, float]]:
        for gps_frame in self._gps_frame_candidates(fix_msg):
            cached = self._gps_mount_offsets_xy.get(gps_frame)
            if cached is not None:
                return cached
            try:
                transform = self._tf_buffer.lookup_transform(
                    self.base_frame,
                    gps_frame,
                    Time(),
                )
            except TransformException:
                continue
            mount_offset = (
                float(transform.transform.translation.x),
                float(transform.transform.translation.y),
            )
            self._gps_mount_offsets_xy[gps_frame] = mount_offset
            self.get_logger().info(
                "Using GPS mount offset "
                f"{self.base_frame}->{gps_frame}: "
                f"x={mount_offset[0]:.3f} y={mount_offset[1]:.3f}"
            )
            return mount_offset

        unresolved_key = "|".join(self._gps_frame_candidates(fix_msg)) or "<empty>"
        if unresolved_key not in self._missing_gps_tf_warned:
            self._missing_gps_tf_warned.add(unresolved_key)
            self.get_logger().warning(
                "GPS mount offset unavailable; publishing antenna position directly "
                f"(base_frame={self.base_frame}, gps_frames={unresolved_key})"
            )
        return None

    def _correct_map_point_to_base_frame(
        self,
        fix_msg: NavSatFix,
        *,
        map_x: float,
        map_y: float,
    ) -> Optional[tuple[float, float]]:
        mount_offset = self._lookup_gps_mount_offset_xy(fix_msg)
        if mount_offset is None:
            return float(map_x), float(map_y)
        if self._latest_base_yaw_rad is None:
            if not self._missing_base_yaw_warned:
                self._missing_base_yaw_warned = True
                self.get_logger().warning(
                    "No odometry yaw available yet; deferring absolute GPS map measurement"
                )
            return None
        return self._apply_base_to_gps_offset(
            map_x=map_x,
            map_y=map_y,
            base_yaw_rad=self._latest_base_yaw_rad,
            base_to_gps_x=mount_offset[0],
            base_to_gps_y=mount_offset[1],
        )

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
        corrected_map_point = self._correct_map_point_to_base_frame(
            fix_msg,
            map_x=float(map_point.x),
            map_y=float(map_point.y),
        )
        if corrected_map_point is None:
            return
        base_map_x, base_map_y = corrected_map_point

        self._odom_pub.publish(
            self._build_odometry_message(
                fix_msg,
                map_frame=self.map_frame,
                pose_covariance_xy=self.pose_covariance_xy,
                map_x=base_map_x,
                map_y=base_map_y,
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

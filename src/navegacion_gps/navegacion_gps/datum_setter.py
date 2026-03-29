import math
import threading
import time
from typing import Any, Optional, Sequence, Tuple

import rclpy
from builtin_interfaces.msg import Time
from geographic_msgs.msg import GeoPose
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from robot_localization.srv import SetDatum as RobotLocalizationSetDatum
from sensor_msgs.msg import Imu, NavSatFix, NavSatStatus
from std_msgs.msg import String

from interfaces.srv import GetDatum, SetDatum


class DatumSetterNode(Node):
    def __init__(self) -> None:
        super().__init__("datum_setter")

        self.declare_parameter("gps_topic", "/gps/fix")
        self.declare_parameter("rtk_status_topic", "/gps/rtk_status")
        self.declare_parameter("imu_topic", "/imu/data")
        self.declare_parameter("set_datum_service", "/datum_setter/set_datum")
        self.declare_parameter("get_datum_service", "/datum_setter/get_datum")
        self.declare_parameter("datum_service", "/datum")
        self.declare_parameter("datum_service_fallback", "/navsat_transform/datum")
        self.declare_parameter("imu_yaw_max_age_s", 1.0)
        self.declare_parameter("datum_wait_timeout_s", 2.0)
        self.declare_parameter("datum_call_timeout_s", 2.5)
        self.declare_parameter("datum_call_retries", 3)
        self.declare_parameter("datum_retry_delay_s", 0.15)

        self.gps_topic = str(self.get_parameter("gps_topic").value)
        self.rtk_status_topic = str(self.get_parameter("rtk_status_topic").value)
        self.imu_topic = str(self.get_parameter("imu_topic").value)
        self.set_datum_service = str(self.get_parameter("set_datum_service").value)
        self.get_datum_service = str(self.get_parameter("get_datum_service").value)
        self.datum_service = str(self.get_parameter("datum_service").value)
        self.datum_service_fallback = str(
            self.get_parameter("datum_service_fallback").value
        )
        self.imu_yaw_max_age_s = max(
            0.05, float(self.get_parameter("imu_yaw_max_age_s").value)
        )
        self.datum_wait_timeout_s = max(
            0.05, float(self.get_parameter("datum_wait_timeout_s").value)
        )
        self.datum_call_timeout_s = max(
            0.1, float(self.get_parameter("datum_call_timeout_s").value)
        )
        self.datum_call_retries = max(
            1, int(self.get_parameter("datum_call_retries").value)
        )
        self.datum_retry_delay_s = max(
            0.0, float(self.get_parameter("datum_retry_delay_s").value)
        )

        self._lock = threading.Lock()
        self._set_operation_lock = threading.Lock()

        self.already_set = False
        self._last_gps_fix: Optional[Tuple[float, float]] = None
        self._last_navsat_rtk = False
        self._last_rtk_status_is_rtk = False
        self._last_rtk_status_text = ""
        self._last_imu_yaw: Optional[float] = None
        self._last_imu_yaw_monotonic: Optional[float] = None
        self._rtk_current = False
        self._pending_auto_set = False

        self._datum_lat: Optional[float] = None
        self._datum_lon: Optional[float] = None
        self._last_set_stamp: Optional[Time] = None
        self._last_set_source = ""
        self._last_set_with_rtk = False

        self._service_group = MutuallyExclusiveCallbackGroup()
        self._client_group = ReentrantCallbackGroup()

        self._datum_client = self.create_client(
            RobotLocalizationSetDatum,
            self.datum_service,
            callback_group=self._client_group,
        )
        self._datum_fallback_client = None
        if self.datum_service_fallback and self.datum_service_fallback != self.datum_service:
            self._datum_fallback_client = self.create_client(
                RobotLocalizationSetDatum,
                self.datum_service_fallback,
                callback_group=self._client_group,
            )
        self._active_datum_client: Optional[Any] = None
        self._active_datum_name: Optional[str] = None
        self._last_datum_error: Optional[str] = None

        self.create_subscription(
            NavSatFix, self.gps_topic, self._on_gps_fix, qos_profile_sensor_data
        )
        self.create_subscription(Imu, self.imu_topic, self._on_imu, qos_profile_sensor_data)
        self.create_subscription(String, self.rtk_status_topic, self._on_rtk_status, 10)
        self.create_service(
            SetDatum,
            self.set_datum_service,
            self._on_set_datum,
            callback_group=self._service_group,
        )
        self.create_service(
            GetDatum,
            self.get_datum_service,
            self._on_get_datum,
            callback_group=self._service_group,
        )

        self.get_logger().info(
            "Datum setter ready "
            f"(set_service={self.set_datum_service}, get_service={self.get_datum_service}, "
            f"gps_topic={self.gps_topic}, imu_topic={self.imu_topic}, "
            f"rtk_status_topic={self.rtk_status_topic}, "
            f"datum_service={self.datum_service}, "
            f"datum_service_fallback={self.datum_service_fallback})"
        )

    @staticmethod
    def _status_text_is_rtk(status_text: str) -> bool:
        text = str(status_text).strip().lower()
        return bool(text) and (
            ("rtk_fixed" in text) or ("rtk_float" in text) or ("rtk_fix" in text)
        )

    @staticmethod
    def _is_valid_lat_lon(lat: float, lon: float) -> bool:
        return (
            math.isfinite(lat)
            and math.isfinite(lon)
            and (-90.0 <= lat <= 90.0)
            and (-180.0 <= lon <= 180.0)
        )

    @staticmethod
    def _extract_yaw_from_quaternion(
        x: float, y: float, z: float, w: float
    ) -> Tuple[bool, float]:
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z) and math.isfinite(w)):
            return False, float("nan")
        norm = math.sqrt((x * x) + (y * y) + (z * z) + (w * w))
        if norm < 1e-8:
            return False, float("nan")

        x_n = x / norm
        y_n = y / norm
        z_n = z / norm
        w_n = w / norm
        siny_cosp = 2.0 * ((w_n * z_n) + (x_n * y_n))
        cosy_cosp = 1.0 - (2.0 * ((y_n * y_n) + (z_n * z_n)))
        return True, float(math.atan2(siny_cosp, cosy_cosp))

    @staticmethod
    def _yaw_to_quaternion_z_w(yaw: float) -> Tuple[float, float]:
        half = 0.5 * float(yaw)
        return float(math.sin(half)), float(math.cos(half))

    @staticmethod
    def _parse_coords(
        coords: Sequence[float],
    ) -> Tuple[bool, str, bool, float, float]:
        coords_list = list(coords)
        if len(coords_list) == 0:
            return True, "", True, float("nan"), float("nan")
        if len(coords_list) != 2:
            return False, "coords must be [] or [lat, lon]", False, float("nan"), float(
                "nan"
            )

        lat = float(coords_list[0])
        lon = float(coords_list[1])
        if not DatumSetterNode._is_valid_lat_lon(lat, lon):
            return (
                False,
                "invalid coords: expected finite lat/lon with ranges "
                "lat[-90,90], lon[-180,180]",
                False,
                float("nan"),
                float("nan"),
            )
        return True, "", False, lat, lon

    @staticmethod
    def _build_status_message(
        already_set_before: bool,
        gps_is_rtk: bool,
        used_current_gps: bool,
        source: str,
    ) -> str:
        base = (
            "Datum was already set; reapplied successfully."
            if already_set_before
            else "Datum set successfully."
        )
        source_msg = (
            " Source=current_gps."
            if used_current_gps
            else " Source=manual_coords."
            if source == "service_manual_coords"
            else " Source=auto_rtk."
        )
        quality_msg = "" if gps_is_rtk else " Warning: datum was applied without RTK quality."
        return f"{base}{source_msg}{quality_msg}"

    def _combined_rtk_locked(self) -> bool:
        return bool(self._last_navsat_rtk or self._last_rtk_status_is_rtk)

    def _get_fresh_imu_yaw(self) -> Tuple[bool, float, str]:
        now_monotonic = time.monotonic()
        with self._lock:
            yaw = self._last_imu_yaw
            stamp = self._last_imu_yaw_monotonic

        if yaw is None or stamp is None:
            return False, float("nan"), "no valid IMU yaw sample available"

        age_s = max(0.0, now_monotonic - stamp)
        if age_s > self.imu_yaw_max_age_s:
            return (
                False,
                float("nan"),
                (
                    "no fresh IMU yaw sample available "
                    f"(age={age_s:.2f}s > {self.imu_yaw_max_age_s:.2f}s)"
                ),
            )
        return True, float(yaw), ""

    def _wait_for_future(self, future: Any, timeout_sec: float) -> Optional[Any]:
        start = time.monotonic()
        while rclpy.ok():
            if future.done():
                return future.result()
            if (time.monotonic() - start) >= timeout_sec:
                return None
            time.sleep(0.01)
        return None

    def _maybe_log_active_datum(self, service_name: str) -> None:
        if self._active_datum_name != service_name:
            self._active_datum_name = service_name
            self.get_logger().info(f"Using datum service: {service_name}")

    def _resolve_datum_client(self) -> Optional[Any]:
        candidates: list[tuple[Any, str, float]] = []
        if self._active_datum_client is not None and self._active_datum_name is not None:
            candidates.append((self._active_datum_client, self._active_datum_name, 0.05))

        candidates.append((self._datum_client, self.datum_service, self.datum_wait_timeout_s))
        if self._datum_fallback_client is not None:
            candidates.append(
                (
                    self._datum_fallback_client,
                    self.datum_service_fallback,
                    self.datum_wait_timeout_s,
                )
            )

        seen = set()
        for client, service_name, timeout_s in candidates:
            key = (id(client), service_name)
            if key in seen:
                continue
            seen.add(key)
            if client.wait_for_service(timeout_sec=timeout_s):
                self._active_datum_client = client
                self._maybe_log_active_datum(service_name)
                return client

        self._last_datum_error = "datum service unavailable"
        self.get_logger().warning(
            "datum service unavailable "
            f"(tried '{self.datum_service}'"
            + (
                f" and '{self.datum_service_fallback}'"
                if self._datum_fallback_client is not None
                else ""
            )
            + ")"
        )
        return None

    def _call_set_datum(self, lat: float, lon: float, yaw: float) -> Tuple[bool, str]:
        for attempt in range(self.datum_call_retries):
            client = self._resolve_datum_client()
            if client is None:
                if attempt + 1 < self.datum_call_retries and self.datum_retry_delay_s > 0.0:
                    time.sleep(self.datum_retry_delay_s)
                continue

            req = RobotLocalizationSetDatum.Request()
            geo_pose = GeoPose()
            geo_pose.position.latitude = float(lat)
            geo_pose.position.longitude = float(lon)
            geo_pose.position.altitude = 0.0
            qz, qw = DatumSetterNode._yaw_to_quaternion_z_w(yaw)
            geo_pose.orientation.x = 0.0
            geo_pose.orientation.y = 0.0
            geo_pose.orientation.z = qz
            geo_pose.orientation.w = qw
            req.geo_pose = geo_pose

            future = client.call_async(req)
            try:
                res = self._wait_for_future(future, timeout_sec=self.datum_call_timeout_s)
            except Exception as exc:
                self._last_datum_error = str(exc)
                if attempt + 1 < self.datum_call_retries and self.datum_retry_delay_s > 0.0:
                    time.sleep(self.datum_retry_delay_s)
                continue

            if res is None:
                self._last_datum_error = "timeout waiting datum response"
                if attempt + 1 < self.datum_call_retries and self.datum_retry_delay_s > 0.0:
                    time.sleep(self.datum_retry_delay_s)
                continue

            self._last_datum_error = None
            return True, ""

        return False, str(self._last_datum_error or "set datum failed")

    def _apply_datum(
        self,
        lat: float,
        lon: float,
        source: str,
        gps_is_rtk: bool,
        used_current_gps: bool,
    ) -> Tuple[bool, str, str, bool]:
        yaw_ok, yaw, yaw_error = self._get_fresh_imu_yaw()
        if not yaw_ok:
            return False, str(yaw_error), "", bool(self.already_set)

        with self._set_operation_lock:
            with self._lock:
                already_set_before = bool(self.already_set)

            ok, error = self._call_set_datum(lat=lat, lon=lon, yaw=yaw)
            if not ok:
                return False, str(error), "", already_set_before

            status_message = DatumSetterNode._build_status_message(
                already_set_before=already_set_before,
                gps_is_rtk=gps_is_rtk,
                used_current_gps=used_current_gps,
                source=source,
            )

            with self._lock:
                self.already_set = True
                self._datum_lat = float(lat)
                self._datum_lon = float(lon)
                self._last_set_stamp = self.get_clock().now().to_msg()
                self._last_set_source = str(source)
                self._last_set_with_rtk = bool(gps_is_rtk)

            return True, "", status_message, already_set_before

    def _auto_set_datum_from_coords(
        self,
        lat: float,
        lon: float,
        gps_is_rtk: bool,
        reason: str,
    ) -> None:
        ok, error, status_message, already_set_before = self._apply_datum(
            lat=lat,
            lon=lon,
            source="auto_rtk",
            gps_is_rtk=gps_is_rtk,
            used_current_gps=True,
        )
        if not ok:
            self.get_logger().warning(
                f"Auto datum set failed ({reason}): {error} "
                f"(lat={lat:.8f}, lon={lon:.8f})"
            )
            return
        self.get_logger().info(
            f"Auto datum set ({reason}) "
            f"(lat={lat:.8f}, lon={lon:.8f}, already_set_before={already_set_before}) - "
            f"{status_message}"
        )

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        if (not math.isfinite(msg.latitude)) or (not math.isfinite(msg.longitude)):
            return

        lat = float(msg.latitude)
        lon = float(msg.longitude)
        navsat_rtk = int(msg.status.status) >= int(NavSatStatus.STATUS_GBAS_FIX)

        auto_set_payload: Optional[Tuple[float, float, bool, str]] = None
        with self._lock:
            self._last_gps_fix = (lat, lon)
            self._last_navsat_rtk = navsat_rtk

            combined_rtk = self._combined_rtk_locked()
            edge = (not self._rtk_current) and combined_rtk
            if edge:
                self._rtk_current = True
                self._pending_auto_set = False
                auto_set_payload = (lat, lon, combined_rtk, "rtk_edge_gps")
            elif not combined_rtk:
                self._rtk_current = False
                self._pending_auto_set = False
            elif self._pending_auto_set:
                self._pending_auto_set = False
                self._rtk_current = True
                auto_set_payload = (lat, lon, combined_rtk, "rtk_edge_pending_gps")
            else:
                self._rtk_current = True

        if auto_set_payload is not None:
            yaw_ok, _yaw, _err = self._get_fresh_imu_yaw()
            if yaw_ok:
                self._auto_set_datum_from_coords(*auto_set_payload)
            else:
                with self._lock:
                    self._pending_auto_set = True

    def _on_rtk_status(self, msg: String) -> None:
        status_text = str(msg.data)
        status_is_rtk = DatumSetterNode._status_text_is_rtk(status_text)

        log_pending_gps = False
        auto_set_payload: Optional[Tuple[float, float, bool, str]] = None
        with self._lock:
            self._last_rtk_status_text = status_text
            self._last_rtk_status_is_rtk = status_is_rtk

            combined_rtk = self._combined_rtk_locked()
            edge = (not self._rtk_current) and combined_rtk
            if edge:
                self._rtk_current = True
                if self._last_gps_fix is None:
                    self._pending_auto_set = True
                    log_pending_gps = True
                else:
                    self._pending_auto_set = False
                    lat, lon = self._last_gps_fix
                    auto_set_payload = (lat, lon, combined_rtk, "rtk_edge_status")
            elif not combined_rtk:
                self._rtk_current = False
                self._pending_auto_set = False
            else:
                self._rtk_current = True

        if log_pending_gps:
            self.get_logger().warning(
                "RTK detected but no valid GPS sample yet; datum auto-set will run on next GPS fix"
            )
        if auto_set_payload is not None:
            yaw_ok, _yaw, _err = self._get_fresh_imu_yaw()
            if yaw_ok:
                self._auto_set_datum_from_coords(*auto_set_payload)
            else:
                with self._lock:
                    self._pending_auto_set = True
                self.get_logger().warning(
                    "RTK detected but no valid IMU yaw yet; "
                    "datum auto-set will run on next valid IMU sample"
                )

    def _on_imu(self, msg: Imu) -> None:
        quat = msg.orientation
        ok, yaw = DatumSetterNode._extract_yaw_from_quaternion(
            quat.x, quat.y, quat.z, quat.w
        )
        if not ok:
            return

        auto_set_payload: Optional[Tuple[float, float, bool, str]] = None
        with self._lock:
            self._last_imu_yaw = float(yaw)
            self._last_imu_yaw_monotonic = time.monotonic()

            combined_rtk = self._combined_rtk_locked()
            if combined_rtk and self._pending_auto_set and self._last_gps_fix is not None:
                self._pending_auto_set = False
                lat, lon = self._last_gps_fix
                auto_set_payload = (lat, lon, combined_rtk, "rtk_edge_pending_imu")

        if auto_set_payload is not None:
            self._auto_set_datum_from_coords(*auto_set_payload)

    def _on_set_datum(
        self,
        request: SetDatum.Request,
        response: SetDatum.Response,
    ) -> SetDatum.Response:
        ok_parse, parse_error, use_current_gps, lat, lon = DatumSetterNode._parse_coords(
            request.coords
        )
        if not ok_parse:
            response.ok = False
            response.error = parse_error
            response.status_message = ""
            response.already_set_before = bool(self.already_set)
            response.used_current_gps = bool(use_current_gps)
            response.gps_is_rtk = bool(self._rtk_current)
            response.applied_lat = float("nan")
            response.applied_lon = float("nan")
            return response

        gps_is_rtk = bool(self._combined_rtk_locked())
        if use_current_gps:
            with self._lock:
                gps_fix = self._last_gps_fix
            if gps_fix is None:
                response.ok = False
                response.error = "no current GPS fix available"
                response.status_message = ""
                response.already_set_before = bool(self.already_set)
                response.used_current_gps = True
                response.gps_is_rtk = gps_is_rtk
                response.applied_lat = float("nan")
                response.applied_lon = float("nan")
                return response
            lat, lon = gps_fix
            source = "service_current_gps"
        else:
            source = "service_manual_coords"

        ok, error, status_message, already_set_before = self._apply_datum(
            lat=lat,
            lon=lon,
            source=source,
            gps_is_rtk=gps_is_rtk,
            used_current_gps=use_current_gps,
        )

        response.ok = ok
        response.error = "" if ok else error
        response.status_message = status_message if ok else ""
        response.already_set_before = already_set_before
        response.used_current_gps = bool(use_current_gps)
        response.gps_is_rtk = gps_is_rtk
        response.applied_lat = float(lat) if ok else float("nan")
        response.applied_lon = float(lon) if ok else float("nan")
        return response

    def _on_get_datum(
        self,
        _request: GetDatum.Request,
        response: GetDatum.Response,
    ) -> GetDatum.Response:
        with self._lock:
            gps_fix = self._last_gps_fix
            datum_lat = self._datum_lat
            datum_lon = self._datum_lon
            last_set_stamp = self._last_set_stamp
            last_set_source = self._last_set_source
            last_set_with_rtk = self._last_set_with_rtk
            already_set = self.already_set
            gps_is_rtk = self._combined_rtk_locked()

        response.ok = True
        response.error = ""
        response.already_set = bool(already_set)
        response.has_current_gps = gps_fix is not None
        response.gps_is_rtk = bool(gps_is_rtk)
        response.current_gps_lat = float(gps_fix[0]) if gps_fix is not None else float("nan")
        response.current_gps_lon = float(gps_fix[1]) if gps_fix is not None else float("nan")
        response.datum_lat = float(datum_lat) if datum_lat is not None else float("nan")
        response.datum_lon = float(datum_lon) if datum_lon is not None else float("nan")
        response.last_set_stamp = last_set_stamp if last_set_stamp is not None else Time()
        response.last_set_source = str(last_set_source)
        response.last_set_with_rtk = bool(last_set_with_rtk)
        return response


def main(args=None) -> None:
    rclpy.init(args=args)
    node = DatumSetterNode()
    executor = MultiThreadedExecutor(num_threads=2)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        rclpy.shutdown()

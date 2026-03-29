#!/usr/bin/env python3

from __future__ import annotations

import math
import os
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Optional, Tuple

import rclpy
import requests
from ament_index_python.packages import get_package_share_directory
from requests.auth import HTTPDigestAuth
from requests.exceptions import RequestException
from rclpy.node import Node
from std_srvs.srv import Trigger

from interfaces.srv import CameraPan, CameraStatus


def _parse_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return values

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key:
            values[key] = value
    return values


def _resolve_default_env_file() -> Path:
    try:
        share_dir = Path(get_package_share_directory("sensores"))
        candidates = [share_dir / ".env"]
        try:
            workspace_root = share_dir.parents[3]
            candidates.append(workspace_root / "src" / "sensores" / ".env")
        except IndexError:
            pass

        for candidate in candidates:
            if candidate.exists():
                return candidate
        return candidates[0]
    except Exception:
        # Fallback when ament index is unavailable; keep this non-fatal.
        return Path(__file__).resolve().parents[2] / ".env"


def _compact_body(body: str, max_len: int = 280) -> str:
    compact = " ".join((body or "").strip().split())
    if not compact:
        return "<empty>"
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 3] + "..."


def _local_xml_text(root: ET.Element, local_name: str) -> Optional[str]:
    for elem in root.iter():
        if elem.tag.rsplit("}", 1)[-1] == local_name and elem.text is not None:
            return elem.text.strip()
    return None


def _to_float(value: str) -> float:
    return float(value.replace(",", ".").strip())


class CamaraNode(Node):
    def __init__(self) -> None:
        super().__init__("camara")

        default_env_file = str(_resolve_default_env_file())
        self.declare_parameter("env_file", default_env_file)
        self._env_file = Path(str(self.get_parameter("env_file").value))
        self._env_data = _parse_env_file(self._env_file)

        self.declare_parameter("camera_host", self._env_cfg("CAMERA_HOST", "192.168.1.64"))
        self.declare_parameter("camera_port", int(self._env_cfg("CAMERA_PORT", "80")))
        self.declare_parameter("camera_user", self._env_cfg("CAMERA_USER", "admin"))
        self.declare_parameter("camera_pass", self._env_cfg("CAMERA_PASS", "CHANGE_ME"))
        self.declare_parameter("camera_channel", int(self._env_cfg("CAMERA_CHANNEL", "1")))
        self.declare_parameter("camera_timeout_s", 2.0)

        # ISAPI PTZ limits (Hikvision defaults used in ptz.sh)
        self.declare_parameter("camera_az_min", 0.0)
        self.declare_parameter("camera_az_max", 355.0)
        self.declare_parameter("camera_el_min", 0.0)
        self.declare_parameter("camera_el_max", 90.0)
        self.declare_parameter("camera_zoom_min", 1.0)
        self.declare_parameter("camera_zoom_max", 4.0)
        self.declare_parameter("camera_zoom_fixed_level", 4.0)
        self.declare_parameter("camera_zoom_zero_level", 1.0)
        self.declare_parameter("camera_zoom_initial_in", False)

        self._host = str(self.get_parameter("camera_host").value)
        self._port = int(self.get_parameter("camera_port").value)
        self._user = str(self.get_parameter("camera_user").value)
        self._password = str(self.get_parameter("camera_pass").value)
        self._channel = max(1, int(self.get_parameter("camera_channel").value))
        self._timeout_s = max(0.2, float(self.get_parameter("camera_timeout_s").value))
        self._az_min = float(self.get_parameter("camera_az_min").value)
        self._az_max = float(self.get_parameter("camera_az_max").value)
        self._el_min = float(self.get_parameter("camera_el_min").value)
        self._el_max = float(self.get_parameter("camera_el_max").value)
        self._zoom_min = float(self.get_parameter("camera_zoom_min").value)
        self._zoom_max = float(self.get_parameter("camera_zoom_max").value)
        self._zoom_fixed_level = self._clamp(
            float(self.get_parameter("camera_zoom_fixed_level").value),
            self._zoom_min,
            self._zoom_max,
        )
        self._zoom_zero_level = self._clamp(
            float(self.get_parameter("camera_zoom_zero_level").value),
            self._zoom_min,
            self._zoom_max,
        )
        self._zoom_in = bool(self.get_parameter("camera_zoom_initial_in").value)
        self._base_url = (
            f"http://{self._host}:{self._port}/ISAPI/PTZCtrl/channels/{self._channel}"
        )
        self._absolute_url = f"{self._base_url}/absoluteEx"
        self._continuous_url = f"{self._base_url}/continuous"
        self._session = requests.Session()
        self._session.auth = HTTPDigestAuth(self._user, self._password)
        self._ready = False
        self._ready_error = ""
        self._last_command = "none"

        self._connect_isapi()

        self.create_service(CameraPan, "/camara/camera_pan", self._on_camera_pan)
        self.create_service(
            Trigger,
            "/camara/camera_zoom_toggle",
            self._on_camera_zoom_toggle,
        )
        self.create_service(CameraStatus, "/camara/camera_status", self._on_camera_status)

        self.get_logger().info(
            "camara node ready "
            f"(env_file={self._env_file}, host={self._host}:{self._port}, "
            f"channel={self._channel}, absolute_url={self._absolute_url}, "
            f"isapi_ready={self._ready})"
        )

    def _env_cfg(self, key: str, default: str) -> str:
        value = self._env_data.get(key, "")
        if value:
            return value
        env_value = os.environ.get(key, "")
        if env_value:
            return env_value
        return default

    def _connect_isapi(self) -> None:
        if not self._host or not self._user or not self._password:
            self._ready = False
            self._ready_error = (
                "missing CAMERA_HOST/CAMERA_USER/CAMERA_PASS in env config"
            )
            self.get_logger().error(self._ready_error)
            return

        try:
            self.get_logger().info(
                "Attempting ISAPI connection "
                f"(host={self._host}, port={self._port}, user={self._user}, "
                f"channel={self._channel}, absolute_url={self._absolute_url})"
            )
            state, err = self._get_absolute_state()
            if state is None:
                raise RuntimeError(err or "ISAPI absoluteEx probe failed")
            _, _, zoom = state
            self._zoom_in = abs(zoom - self._zoom_zero_level) > 0.05
            self._ready = True
            self._ready_error = ""
        except Exception as exc:
            self._ready = False
            self._ready_error = f"ISAPI init failed: {exc}"
            self.get_logger().error(self._ready_error)

    def _clamp(self, value: float, lo: float, hi: float) -> float:
        return max(float(lo), min(float(hi), float(value)))

    def _normalize_azimuth(self, angle_deg: float) -> float:
        angle = math.fmod(float(angle_deg), 360.0)
        if angle < 0.0:
            angle += 360.0
        # Align with ptz.sh behavior: if wrapped past max, snap to min.
        if angle > self._az_max:
            angle = self._az_min
        return angle

    def _request_isapi(
        self, method: str, url: str, data: Optional[str] = None
    ) -> Tuple[Optional[str], str]:
        headers = {"Content-Type": "application/xml"} if data is not None else None
        try:
            res = self._session.request(
                method=method,
                url=url,
                data=data,
                headers=headers,
                timeout=self._timeout_s,
            )
        except RequestException as exc:
            return None, f"ISAPI {method} request failed: {exc}"

        if not res.ok:
            body = _compact_body(res.text)
            return (
                None,
                f"ISAPI {method} failed: HTTP {res.status_code} {res.reason}; body='{body}'",
            )
        return res.text, ""

    def _get_absolute_state(self) -> Tuple[Optional[Tuple[float, float, float]], str]:
        xml_text, err = self._request_isapi("GET", self._absolute_url)
        if xml_text is None:
            return None, err
        try:
            root = ET.fromstring(xml_text)
            el_raw = _local_xml_text(root, "elevation")
            az_raw = _local_xml_text(root, "azimuth")
            zm_raw = _local_xml_text(root, "absoluteZoom")
            if el_raw is None or az_raw is None or zm_raw is None:
                return (
                    None,
                    "ISAPI absoluteEx response missing elevation/azimuth/absoluteZoom",
                )
            elevation = _to_float(el_raw)
            azimuth = _to_float(az_raw)
            zoom = _to_float(zm_raw)
            return (elevation, azimuth, zoom), ""
        except Exception as exc:
            body = _compact_body(xml_text)
            return None, f"invalid ISAPI absoluteEx XML: {exc}; body='{body}'"

    def _set_absolute_state(self, elevation: float, azimuth: float, zoom: float) -> Tuple[bool, str]:
        el = int(round(self._clamp(elevation, self._el_min, self._el_max)))
        az = int(round(self._clamp(azimuth, self._az_min, self._az_max)))
        zm = int(round(self._clamp(zoom, self._zoom_min, self._zoom_max)))
        payload = (
            '<PTZAbsoluteEx version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">'
            f"<elevation>{el}</elevation>"
            f"<azimuth>{az}</azimuth>"
            f"<absoluteZoom>{zm}</absoluteZoom>"
            "</PTZAbsoluteEx>"
        )
        _, err = self._request_isapi("PUT", self._absolute_url, data=payload)
        if err:
            return False, err
        return True, ""

    def _set_pan_absolute(self, target_azimuth: float) -> Tuple[bool, str]:
        state, err = self._get_absolute_state()
        if state is None:
            return False, f"cannot read current PTZ state: {err}"
        _, _, current_zoom = state
        # Force neutral tilt in every outgoing pan command.
        return self._set_absolute_state(0.0, target_azimuth, current_zoom)

    def _set_zoom_absolute(self, target_zoom: float) -> Tuple[bool, str]:
        state, err = self._get_absolute_state()
        if state is None:
            return False, f"cannot read current PTZ state: {err}"
        _, current_az, _ = state
        # Keep zoom command aligned with neutral tilt convention.
        return self._set_absolute_state(0.0, current_az, target_zoom)

    def _zoom_toggle(self) -> Tuple[bool, str]:
        epsilon = 0.05
        state, err = self._get_absolute_state()
        if state is not None:
            current_zoom = float(state[2])
            is_zero = abs(current_zoom - self._zoom_zero_level) <= epsilon
            target = self._zoom_fixed_level if is_zero else self._zoom_zero_level
        else:
            target = self._zoom_zero_level if self._zoom_in else self._zoom_fixed_level
            self.get_logger().warning(
                f"zoom_toggle: using fallback toggle state because absoluteEx read failed ({err})"
            )

        ok, set_err = self._set_zoom_absolute(target)
        if ok:
            self._zoom_in = abs(target - self._zoom_zero_level) > epsilon
            return True, ""
        return False, set_err

    def _on_camera_pan(
        self, request: CameraPan.Request, response: CameraPan.Response
    ) -> CameraPan.Response:
        if not self._ready:
            response.ok = False
            response.error = self._ready_error or "camera is not ready"
            response.applied_angle_deg = 0.0
            return response

        input_angle = float(request.angle_deg)
        if not math.isfinite(input_angle):
            response.ok = False
            response.error = "angle_deg must be finite"
            response.applied_angle_deg = 0.0
            return response

        applied_angle = self._normalize_azimuth(input_angle)
        ok, err = self._set_pan_absolute(applied_angle)

        response.ok = bool(ok)
        response.error = "" if ok else err
        response.applied_angle_deg = float(applied_angle)
        if ok:
            self._last_command = f"angle:{applied_angle:.1f}"
        return response

    def _on_camera_zoom_toggle(
        self, _request: Trigger.Request, response: Trigger.Response
    ) -> Trigger.Response:
        if not self._ready:
            response.success = False
            response.message = self._ready_error or "camera is not ready"
            return response

        ok, err = self._zoom_toggle()
        response.success = bool(ok)
        response.message = "" if ok else err
        if ok:
            self._last_command = "zoom_toggle"
        return response

    def _on_camera_status(
        self, _request: CameraStatus.Request, response: CameraStatus.Response
    ) -> CameraStatus.Response:
        if not self._ready:
            response.ok = False
            response.error = self._ready_error or "camera is not ready"
            response.last_command = self._last_command
            response.zoom_in = bool(self._zoom_in)
            return response

        state, err = self._get_absolute_state()
        if state is None:
            response.ok = False
            response.error = err
            response.last_command = self._last_command
            response.zoom_in = bool(self._zoom_in)
            return response

        self._zoom_in = abs(state[2] - self._zoom_zero_level) > 0.05
        response.ok = True
        response.error = ""
        response.last_command = self._last_command
        response.zoom_in = bool(self._zoom_in)
        return response


def main(args=None) -> None:
    rclpy.init(args=args)
    node = CamaraNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()

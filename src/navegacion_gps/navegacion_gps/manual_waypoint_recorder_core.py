from __future__ import annotations
"""Pure waypoint recording logic usable without a ROS runtime."""

from dataclasses import dataclass
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml


NO_FIX_STATUS = -1
EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class GpsFixSample:
    """Minimal GPS sample used by the recorder core."""

    lat: float
    lon: float
    status: int
    covariance_0: float


@dataclass(frozen=True)
class OdomSnapshot:
    """Optional local pose snapshot stored alongside a waypoint."""

    x: float
    y: float
    yaw_deg: float


def _is_finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def haversine_distance_m(
    lat_a_deg: float,
    lon_a_deg: float,
    lat_b_deg: float,
    lon_b_deg: float,
) -> float:
    """Return the great-circle distance between two WGS84 points."""
    lat_a = math.radians(float(lat_a_deg))
    lon_a = math.radians(float(lon_a_deg))
    lat_b = math.radians(float(lat_b_deg))
    lon_b = math.radians(float(lon_b_deg))

    dlat = lat_b - lat_a
    dlon = lon_b - lon_a
    sin_dlat = math.sin(dlat * 0.5)
    sin_dlon = math.sin(dlon * 0.5)
    a = (sin_dlat * sin_dlat) + math.cos(lat_a) * math.cos(lat_b) * (sin_dlon * sin_dlon)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return EARTH_RADIUS_M * c


def is_fix_recordable(
    fix: GpsFixSample,
    *,
    max_covariance: float,
) -> bool:
    """Return whether the GPS fix is good enough to keep."""
    if not all(_is_finite(value) for value in (fix.lat, fix.lon, fix.covariance_0)):
        return False
    if int(fix.status) == NO_FIX_STATUS:
        return False
    return float(fix.covariance_0) <= float(max_covariance)


def _build_waypoint_entry(
    *,
    index: int,
    fix: GpsFixSample,
    odom_snapshot: Optional[OdomSnapshot],
) -> Dict[str, Any]:
    waypoint: Dict[str, Any] = {
        "lat": float(fix.lat),
        "lon": float(fix.lon),
        "label": f"wp_{int(index)}",
    }
    if odom_snapshot is not None and all(
        _is_finite(value)
        for value in (odom_snapshot.x, odom_snapshot.y, odom_snapshot.yaw_deg)
    ):
        waypoint["x"] = float(odom_snapshot.x)
        waypoint["y"] = float(odom_snapshot.y)
        waypoint["yaw_deg"] = float(odom_snapshot.yaw_deg)
    return waypoint


def covariance_0_or_inf(position_covariance: Optional[Sequence[Any]]) -> float:
    """Return covariance[0] without relying on container truthiness."""
    if position_covariance is None:
        return float("inf")
    try:
        if len(position_covariance) <= 0:
            return float("inf")
        return float(position_covariance[0])
    except (IndexError, TypeError, ValueError):
        return float("inf")


class ManualWaypointRecorderCore:
    """Record spaced GPS waypoints while filtering bad fixes."""

    def __init__(
        self,
        *,
        min_distance_m: float = 3.0,
        max_covariance: float = 4.0,
    ) -> None:
        self.min_distance_m = max(0.0, float(min_distance_m))
        self.max_covariance = max(0.0, float(max_covariance))
        self._waypoints: List[Dict[str, Any]] = []
        self._last_recorded_fix: Optional[GpsFixSample] = None

    @property
    def count(self) -> int:
        return len(self._waypoints)

    def clear(self) -> None:
        self._waypoints = []
        self._last_recorded_fix = None

    def waypoints(self) -> List[Dict[str, Any]]:
        return [dict(item) for item in self._waypoints]

    def process_fix(
        self,
        fix: GpsFixSample,
        *,
        odom_snapshot: Optional[OdomSnapshot] = None,
    ) -> Optional[Tuple[Dict[str, Any], float]]:
        if not is_fix_recordable(fix, max_covariance=self.max_covariance):
            return None

        distance_m = 0.0
        if self._last_recorded_fix is not None:
            distance_m = haversine_distance_m(
                self._last_recorded_fix.lat,
                self._last_recorded_fix.lon,
                fix.lat,
                fix.lon,
            )
            if distance_m < self.min_distance_m:
                return None

        waypoint = _build_waypoint_entry(
            index=len(self._waypoints),
            fix=fix,
            odom_snapshot=odom_snapshot,
        )
        self._waypoints.append(waypoint)
        self._last_recorded_fix = fix
        return dict(waypoint), float(distance_m)


def build_recorded_waypoints_document(
    waypoints: Sequence[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """Build the YAML document saved by the recorder node."""
    document_waypoints: List[Dict[str, Any]] = []
    for index, item in enumerate(waypoints):
        lat = item.get("lat")
        lon = item.get("lon")
        if not _is_finite(lat) or not _is_finite(lon):
            raise ValueError(f"invalid lat/lon at waypoint {index}")

        document_item: Dict[str, Any] = {
            "lat": float(lat),
            "lon": float(lon),
            "label": str(item.get("label") or f"wp_{index}"),
        }
        for key in ("x", "y", "yaw_deg"):
            value = item.get(key)
            if value is not None and _is_finite(value):
                document_item[key] = float(value)
        document_waypoints.append(document_item)
    return {"waypoints": document_waypoints}


def save_recorded_waypoints_yaml(
    file_path: Path,
    waypoints: Sequence[Dict[str, Any]],
) -> Tuple[bool, str, int]:
    """Persist recorded waypoints to disk using the recorder schema."""
    if len(waypoints) == 0:
        return False, "no recorded waypoints to save", 0

    try:
        document = build_recorded_waypoints_document(waypoints)
    except ValueError as exc:
        return False, str(exc), 0

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        return False, f"failed creating output dir: {exc}", 0

    try:
        with file_path.open("w", encoding="utf-8") as handle:
            yaml.safe_dump(document, handle, sort_keys=False)
    except Exception as exc:
        return False, f"failed writing waypoints file: {exc}", 0
    return True, "", len(document["waypoints"])

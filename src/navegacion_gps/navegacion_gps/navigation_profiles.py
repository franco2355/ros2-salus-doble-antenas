from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
from typing import Any, Mapping, Optional

import yaml


@dataclass(frozen=True)
class NavigationProfile:
    profile_id: str
    map_frame: str
    fromll_frame: str
    keepout_mask_frame: str
    odom_topic: str
    navsat_use_odometry_yaw: Optional[bool]
    datum_lat: Optional[float]
    datum_lon: Optional[float]
    datum_yaw_deg: Optional[float]


def _require_mapping(raw: Any, *, field_name: str) -> Mapping[str, Any]:
    if not isinstance(raw, Mapping):
        raise ValueError(f"Navigation profiles field '{field_name}' must be a mapping")
    return raw


def _require_non_empty_str(raw: Any, *, field_name: str, profile_id: str) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError(
            f"Navigation profile '{profile_id}' is missing required field '{field_name}'"
        )
    return value


def _optional_bool(raw: Any, *, field_name: str, profile_id: str) -> Optional[bool]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    value = str(raw).strip().lower()
    if value in {"true", "1", "yes", "on"}:
        return True
    if value in {"false", "0", "no", "off"}:
        return False
    raise ValueError(
        f"Navigation profile '{profile_id}' field '{field_name}' must be boolean-like"
    )


def _optional_finite_float(raw: Any, *, field_name: str, profile_id: str) -> Optional[float]:
    if raw is None:
        return None
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError(
            f"Navigation profile '{profile_id}' field '{field_name}' must be finite"
        )
    return value


def load_navigation_profile(path: Path | str, profile_id: str) -> NavigationProfile:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    profiles_raw = _require_mapping(raw.get("profiles", {}), field_name="profiles")
    profile_raw = profiles_raw.get(profile_id)
    if profile_raw is None:
        raise ValueError(f"Unknown navigation profile '{profile_id}' in '{path}'")
    profile_mapping = _require_mapping(
        profile_raw,
        field_name=f"profiles.{profile_id}",
    )
    return NavigationProfile(
        profile_id=str(profile_id),
        map_frame=_require_non_empty_str(
            profile_mapping.get("map_frame"),
            field_name="map_frame",
            profile_id=profile_id,
        ),
        fromll_frame=_require_non_empty_str(
            profile_mapping.get("fromll_frame"),
            field_name="fromll_frame",
            profile_id=profile_id,
        ),
        keepout_mask_frame=_require_non_empty_str(
            profile_mapping.get("keepout_mask_frame"),
            field_name="keepout_mask_frame",
            profile_id=profile_id,
        ),
        odom_topic=_require_non_empty_str(
            profile_mapping.get("odom_topic"),
            field_name="odom_topic",
            profile_id=profile_id,
        ),
        navsat_use_odometry_yaw=_optional_bool(
            profile_mapping.get("navsat_use_odometry_yaw"),
            field_name="navsat_use_odometry_yaw",
            profile_id=profile_id,
        ),
        datum_lat=_optional_finite_float(
            profile_mapping.get("datum_lat"),
            field_name="datum_lat",
            profile_id=profile_id,
        ),
        datum_lon=_optional_finite_float(
            profile_mapping.get("datum_lon"),
            field_name="datum_lon",
            profile_id=profile_id,
        ),
        datum_yaw_deg=_optional_finite_float(
            profile_mapping.get("datum_yaw_deg"),
            field_name="datum_yaw_deg",
            profile_id=profile_id,
        ),
    )

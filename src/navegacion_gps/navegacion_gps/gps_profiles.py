from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import math
import random

from sensor_msgs.msg import NavSatFix, NavSatStatus


@dataclass(frozen=True)
class SimGpsProfile:
    """Static definition of a simulated GPS behavior profile."""

    name: str
    horizontal_noise_stddev_m: float
    vertical_noise_stddev_m: float
    bias_walk_stddev_m_per_sqrt_s: float
    publish_rate_hz: float
    publish_jitter_stddev_s: float
    horizontal_covariance_m2: float
    vertical_covariance_m2: float
    navsat_status: int
    rtk_status_text: str
    description: str


# `ideal` is intentionally truly ideal in position, but still reports a tiny
# non-zero covariance so downstream filters keep a sane diagonal.
SIM_GPS_PROFILES: dict[str, SimGpsProfile] = {
    "ideal": SimGpsProfile(
        name="ideal",
        horizontal_noise_stddev_m=0.0,
        vertical_noise_stddev_m=0.0,
        bias_walk_stddev_m_per_sqrt_s=0.0,
        publish_rate_hz=0.0,
        publish_jitter_stddev_s=0.0,
        horizontal_covariance_m2=0.01**2,
        vertical_covariance_m2=0.02**2,
        navsat_status=NavSatStatus.STATUS_FIX,
        rtk_status_text="SIM_IDEAL",
        description="Idealized GPS passthrough for architecture and smoke tests.",
    ),
    "f9p_rtk": SimGpsProfile(
        name="f9p_rtk",
        horizontal_noise_stddev_m=0.02,
        vertical_noise_stddev_m=0.04,
        bias_walk_stddev_m_per_sqrt_s=0.002,
        publish_rate_hz=10.0,
        publish_jitter_stddev_s=0.01,
        horizontal_covariance_m2=0.02**2,
        vertical_covariance_m2=0.04**2,
        navsat_status=NavSatStatus.STATUS_GBAS_FIX,
        rtk_status_text="RTK_FIXED",
        description="RTK-fixed profile approximating a u-blox F9P class receiver.",
    ),
    "m8n": SimGpsProfile(
        name="m8n",
        horizontal_noise_stddev_m=1.5,
        vertical_noise_stddev_m=2.5,
        bias_walk_stddev_m_per_sqrt_s=0.05,
        publish_rate_hz=5.0,
        publish_jitter_stddev_s=0.03,
        horizontal_covariance_m2=1.5**2,
        vertical_covariance_m2=2.5**2,
        navsat_status=NavSatStatus.STATUS_FIX,
        rtk_status_text="3D_FIX",
        description="Single-band GPS profile approximating a u-blox NEO-M8N class receiver.",
    ),
}


def supported_gps_profiles() -> tuple[str, ...]:
    return tuple(sorted(SIM_GPS_PROFILES))


def resolve_gps_profile(profile_name: str) -> SimGpsProfile:
    key = str(profile_name).strip().lower()
    if key not in SIM_GPS_PROFILES:
        valid_profiles = ", ".join(supported_gps_profiles())
        raise ValueError(
            f"Unsupported gps_profile '{profile_name}'. Valid values: {valid_profiles}"
        )
    return SIM_GPS_PROFILES[key]


def resolve_gps_profile_from_legacy(
    profile_name: str,
    realism_mode_enabled: bool,
) -> SimGpsProfile:
    key = str(profile_name).strip()
    if key:
        return resolve_gps_profile(key)
    return resolve_gps_profile("m8n" if bool(realism_mode_enabled) else "ideal")


def build_custom_gps_profile(
    *,
    name: str,
    publish_rate_hz: float,
    publish_jitter_stddev_s: float,
    horizontal_noise_stddev_m: float,
    vertical_noise_stddev_m: float,
    bias_walk_stddev_m_per_sqrt_s: float,
    navsat_status: int,
    rtk_status_text: str,
    description: str,
) -> SimGpsProfile:
    return SimGpsProfile(
        name=name,
        horizontal_noise_stddev_m=max(0.0, float(horizontal_noise_stddev_m)),
        vertical_noise_stddev_m=max(0.0, float(vertical_noise_stddev_m)),
        bias_walk_stddev_m_per_sqrt_s=max(0.0, float(bias_walk_stddev_m_per_sqrt_s)),
        publish_rate_hz=max(0.0, float(publish_rate_hz)),
        publish_jitter_stddev_s=max(0.0, float(publish_jitter_stddev_s)),
        horizontal_covariance_m2=max(0.0, float(horizontal_noise_stddev_m)) ** 2,
        vertical_covariance_m2=max(0.0, float(vertical_noise_stddev_m)) ** 2,
        navsat_status=int(navsat_status),
        rtk_status_text=str(rtk_status_text),
        description=str(description),
    )


def geodetic_offset_meters(
    latitude_deg: float,
    longitude_deg: float,
    north_m: float,
    east_m: float,
) -> tuple[float, float]:
    meters_per_deg_lat = 111_320.0
    cos_lat = max(1.0e-6, abs(math.cos(math.radians(float(latitude_deg)))))
    meters_per_deg_lon = meters_per_deg_lat * cos_lat
    return (
        float(latitude_deg) + float(north_m) / meters_per_deg_lat,
        float(longitude_deg) + float(east_m) / meters_per_deg_lon,
    )


def stamp_to_nanoseconds(msg) -> int:
    return int(msg.header.stamp.sec) * 1_000_000_000 + int(msg.header.stamp.nanosec)


class SimGpsFixProcessor:
    """Stateful GPS degrader shared by the modern and legacy simulation paths."""

    def __init__(self, profile: SimGpsProfile, *, random_seed: int = 0) -> None:
        self.profile = profile
        self._random = random.Random(None if int(random_seed) == 0 else int(random_seed))
        self._next_publish_time_ns = 0
        self._last_publish_time_ns: int | None = None
        self._bias_north_m = 0.0
        self._bias_east_m = 0.0
        self._bias_alt_m = 0.0

    def rtk_status_text(self) -> str:
        return self.profile.rtk_status_text

    def _advance_bias(self, dt_s: float) -> None:
        if self.profile.bias_walk_stddev_m_per_sqrt_s <= 0.0:
            return
        sigma = self.profile.bias_walk_stddev_m_per_sqrt_s * math.sqrt(max(0.0, dt_s))
        self._bias_north_m += self._random.gauss(0.0, sigma)
        self._bias_east_m += self._random.gauss(0.0, sigma)
        self._bias_alt_m += self._random.gauss(0.0, sigma)

    def _schedule_next_publish(self, reference_time_ns: int) -> None:
        if self.profile.publish_rate_hz <= 0.0:
            self._next_publish_time_ns = reference_time_ns
            return
        base_period_s = 1.0 / self.profile.publish_rate_hz
        jitter_s = self._random.gauss(0.0, self.profile.publish_jitter_stddev_s)
        period_s = max(0.0, base_period_s + jitter_s)
        self._next_publish_time_ns = reference_time_ns + int(period_s * 1_000_000_000)

    def process_fix(self, msg: NavSatFix, reference_time_ns: int) -> NavSatFix | None:
        if (
            self.profile.publish_rate_hz > 0.0
            and reference_time_ns < self._next_publish_time_ns
        ):
            return None

        if self._last_publish_time_ns is None:
            dt_s = 0.0
        else:
            dt_s = max(
                0.0,
                (reference_time_ns - self._last_publish_time_ns) / 1_000_000_000.0,
            )
        self._last_publish_time_ns = reference_time_ns
        self._advance_bias(dt_s)

        profiled_msg = deepcopy(msg)
        north_m = self._bias_north_m + self._random.gauss(
            0.0, self.profile.horizontal_noise_stddev_m
        )
        east_m = self._bias_east_m + self._random.gauss(
            0.0, self.profile.horizontal_noise_stddev_m
        )
        profiled_msg.latitude, profiled_msg.longitude = geodetic_offset_meters(
            profiled_msg.latitude,
            profiled_msg.longitude,
            north_m,
            east_m,
        )
        profiled_msg.altitude = (
            float(profiled_msg.altitude)
            + self._bias_alt_m
            + self._random.gauss(0.0, self.profile.vertical_noise_stddev_m)
        )
        profiled_msg.position_covariance = [
            self.profile.horizontal_covariance_m2,
            0.0,
            0.0,
            0.0,
            self.profile.horizontal_covariance_m2,
            0.0,
            0.0,
            0.0,
            self.profile.vertical_covariance_m2,
        ]
        profiled_msg.position_covariance_type = (
            NavSatFix.COVARIANCE_TYPE_DIAGONAL_KNOWN
        )
        profiled_msg.status.status = self.profile.navsat_status
        self._schedule_next_publish(reference_time_ns)
        return profiled_msg

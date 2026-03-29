from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
from typing import Deque, Optional

from navegacion_gps.heading_math import normalize_yaw_deg


@dataclass(frozen=True)
class GpsFixSample:
    lat: float
    lon: float
    stamp_s: float


@dataclass(frozen=True)
class CourseHeadingEstimate:
    valid: bool
    reason: str
    yaw_deg: Optional[float]
    distance_m: float
    speed_mps: float
    steer_deg: Optional[float]
    yaw_rate_rps: float
    latest_fix_age_s: Optional[float]
    sample_dt_s: Optional[float]


def ll_delta_to_north_east_m(
    lat: float,
    lon: float,
    ref_lat: float,
    ref_lon: float,
) -> tuple[float, float]:
    meters_per_deg_lat = 111_320.0
    cos_lat = max(1.0e-6, abs(math.cos(math.radians(float(ref_lat)))))
    meters_per_deg_lon = meters_per_deg_lat * cos_lat
    north_m = (float(lat) - float(ref_lat)) * meters_per_deg_lat
    east_m = (float(lon) - float(ref_lon)) * meters_per_deg_lon
    return north_m, east_m


def ros_yaw_deg_from_north_east(north_m: float, east_m: float) -> float:
    return normalize_yaw_deg(math.degrees(math.atan2(float(north_m), float(east_m))))


class GpsCourseHeadingEstimator:
    def __init__(
        self,
        *,
        min_distance_m: float = 2.5,
        min_speed_mps: float = 0.8,
        max_abs_steer_deg: float = 6.0,
        max_abs_yaw_rate_rps: float = 0.12,
        max_fix_age_s: float = 0.5,
        history_window_s: float = 12.0,
        invalid_hold_s: float = 0.0,
    ) -> None:
        self.min_distance_m = max(0.01, float(min_distance_m))
        self.min_speed_mps = max(0.0, float(min_speed_mps))
        self.max_abs_steer_deg = max(0.0, float(max_abs_steer_deg))
        self.max_abs_yaw_rate_rps = max(0.0, float(max_abs_yaw_rate_rps))
        self.max_fix_age_s = max(0.01, float(max_fix_age_s))
        self.history_window_s = max(self.max_fix_age_s, float(history_window_s))
        self.invalid_hold_s = max(0.0, float(invalid_hold_s))
        self._fixes: Deque[GpsFixSample] = deque()
        self._last_valid_estimate: Optional[CourseHeadingEstimate] = None
        self._last_valid_now_s: Optional[float] = None

    def add_fix(self, lat: float, lon: float, stamp_s: float) -> None:
        if not (
            math.isfinite(float(lat))
            and math.isfinite(float(lon))
            and math.isfinite(float(stamp_s))
        ):
            return
        sample = GpsFixSample(lat=float(lat), lon=float(lon), stamp_s=float(stamp_s))
        self._fixes.append(sample)
        self._trim_history(now_s=sample.stamp_s)

    def estimate(
        self,
        *,
        now_s: float,
        speed_mps: float,
        steer_deg: Optional[float],
        steer_valid: bool,
        yaw_rate_rps: float,
    ) -> CourseHeadingEstimate:
        if not math.isfinite(float(now_s)):
            return self._invalid(
                reason="invalid_clock",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=None,
            )

        self._trim_history(now_s=float(now_s))
        if not self._fixes:
            return self._invalid(
                reason="no_fix",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=None,
            )

        latest = self._fixes[-1]
        latest_fix_age_s = max(0.0, float(now_s) - latest.stamp_s)
        if latest_fix_age_s > self.max_fix_age_s:
            return self._invalid(
                reason="stale_fix",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        if not math.isfinite(float(speed_mps)) or float(speed_mps) < self.min_speed_mps:
            return self._invalid(
                reason="speed_below_threshold",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        if not steer_valid or steer_deg is None or not math.isfinite(float(steer_deg)):
            return self._invalid(
                reason="steer_invalid",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        if abs(float(steer_deg)) > self.max_abs_steer_deg:
            return self._invalid_or_hold(
                reason="steer_too_high",
                now_s=float(now_s),
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        if (
            not math.isfinite(float(yaw_rate_rps))
            or abs(float(yaw_rate_rps)) > self.max_abs_yaw_rate_rps
        ):
            return self._invalid_or_hold(
                reason="yaw_rate_too_high",
                now_s=float(now_s),
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        candidate: Optional[GpsFixSample] = None
        candidate_distance_m = 0.0
        for sample in self._fixes:
            if sample.stamp_s >= latest.stamp_s:
                continue
            north_m, east_m = ll_delta_to_north_east_m(
                lat=latest.lat,
                lon=latest.lon,
                ref_lat=sample.lat,
                ref_lon=sample.lon,
            )
            distance_m = math.hypot(north_m, east_m)
            if distance_m >= self.min_distance_m:
                candidate = sample
                candidate_distance_m = distance_m
                break

        if candidate is None:
            return self._invalid(
                reason="distance_below_threshold",
                speed_mps=speed_mps,
                steer_deg=steer_deg,
                yaw_rate_rps=yaw_rate_rps,
                latest_fix_age_s=latest_fix_age_s,
            )

        north_m, east_m = ll_delta_to_north_east_m(
            lat=latest.lat,
            lon=latest.lon,
            ref_lat=candidate.lat,
            ref_lon=candidate.lon,
        )
        yaw_deg = ros_yaw_deg_from_north_east(north_m=north_m, east_m=east_m)
        estimate = CourseHeadingEstimate(
            valid=True,
            reason="ok",
            yaw_deg=float(yaw_deg),
            distance_m=float(candidate_distance_m),
            speed_mps=float(speed_mps),
            steer_deg=float(steer_deg),
            yaw_rate_rps=float(yaw_rate_rps),
            latest_fix_age_s=float(latest_fix_age_s),
            sample_dt_s=float(max(0.0, latest.stamp_s - candidate.stamp_s)),
        )
        self._last_valid_estimate = estimate
        self._last_valid_now_s = float(now_s)
        return estimate

    def _trim_history(self, *, now_s: float) -> None:
        threshold_s = float(now_s) - self.history_window_s
        while self._fixes and self._fixes[0].stamp_s < threshold_s:
            self._fixes.popleft()

    @staticmethod
    def _invalid(
        *,
        reason: str,
        speed_mps: float,
        steer_deg: Optional[float],
        yaw_rate_rps: float,
        latest_fix_age_s: Optional[float],
    ) -> CourseHeadingEstimate:
        return CourseHeadingEstimate(
            valid=False,
            reason=str(reason),
            yaw_deg=None,
            distance_m=0.0,
            speed_mps=float(speed_mps) if math.isfinite(float(speed_mps)) else 0.0,
            steer_deg=(
                float(steer_deg)
                if steer_deg is not None and math.isfinite(float(steer_deg))
                else None
            ),
            yaw_rate_rps=(
                float(yaw_rate_rps) if math.isfinite(float(yaw_rate_rps)) else 0.0
            ),
            latest_fix_age_s=latest_fix_age_s,
            sample_dt_s=None,
        )

    def _invalid_or_hold(
        self,
        *,
        reason: str,
        now_s: float,
        speed_mps: float,
        steer_deg: Optional[float],
        yaw_rate_rps: float,
        latest_fix_age_s: Optional[float],
    ) -> CourseHeadingEstimate:
        if self._can_hold_last_valid(now_s=now_s):
            last_valid = self._last_valid_estimate
            if last_valid is not None and last_valid.yaw_deg is not None:
                return CourseHeadingEstimate(
                    valid=True,
                    reason=f"hold_{reason}",
                    yaw_deg=float(last_valid.yaw_deg),
                    distance_m=float(last_valid.distance_m),
                    speed_mps=float(speed_mps),
                    steer_deg=(
                        float(steer_deg)
                        if steer_deg is not None and math.isfinite(float(steer_deg))
                        else None
                    ),
                    yaw_rate_rps=(
                        float(yaw_rate_rps)
                        if math.isfinite(float(yaw_rate_rps))
                        else 0.0
                    ),
                    latest_fix_age_s=latest_fix_age_s,
                    sample_dt_s=last_valid.sample_dt_s,
                )

        return self._invalid(
            reason=reason,
            speed_mps=speed_mps,
            steer_deg=steer_deg,
            yaw_rate_rps=yaw_rate_rps,
            latest_fix_age_s=latest_fix_age_s,
        )

    def _can_hold_last_valid(self, *, now_s: float) -> bool:
        if self.invalid_hold_s <= 0.0:
            return False
        if self._last_valid_estimate is None or self._last_valid_now_s is None:
            return False
        if self._last_valid_estimate.yaw_deg is None:
            return False
        if (float(now_s) - self._last_valid_now_s) > self.invalid_hold_s:
            return False
        return True

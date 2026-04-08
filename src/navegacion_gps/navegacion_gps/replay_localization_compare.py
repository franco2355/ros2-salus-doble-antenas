from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
import json
import math
from pathlib import Path
from typing import Any

import rosbag2_py
from rclpy.serialization import deserialize_message
from rosidl_runtime_py.utilities import get_message

from navegacion_gps.nav_benchmarking import DEFAULT_JUMP_THRESHOLD_DEG
from navegacion_gps.nav_benchmarking import json_ready
from navegacion_gps.nav_benchmarking import summarize_angle
from navegacion_gps.nav_benchmarking import summarize_angle_jumps
from navegacion_gps.nav_benchmarking import summarize_scalar


ODOM_TOPICS = {
    "/odometry/local": "odometry_local",
    "/odometry/global": "odometry_global",
    "/gps/odometry_map": "gps_odometry_map",
}

TF_TARGETS = {
    ("map", "odom"): "tf_map_odom",
    ("odom", "base_footprint"): "tf_odom_base_footprint",
}


def quaternion_to_yaw_deg(q: Any) -> float:
    x = float(q.x)
    y = float(q.y)
    z = float(q.z)
    w = float(q.w)
    siny_cosp = 2.0 * ((w * z) + (x * y))
    cosy_cosp = 1.0 - (2.0 * ((y * y) + (z * z)))
    return math.degrees(math.atan2(siny_cosp, cosy_cosp))


def stamp_to_seconds(stamp: Any) -> float:
    return float(stamp.sec) + (float(stamp.nanosec) / 1_000_000_000.0)


def normalize_delta_yaw_deg(delta_yaw_deg: float) -> float:
    return math.degrees(
        math.atan2(
            math.sin(math.radians(float(delta_yaw_deg))),
            math.cos(math.radians(float(delta_yaw_deg))),
        )
    )


def _nearest_index(reference_times: Sequence[float], stamp_s: float, start_idx: int = 0) -> int:
    if not reference_times:
        raise ValueError("reference_times cannot be empty")
    idx = max(0, int(start_idx))
    while idx + 1 < len(reference_times):
        current_dt = abs(reference_times[idx] - float(stamp_s))
        next_dt = abs(reference_times[idx + 1] - float(stamp_s))
        if next_dt > current_dt:
            break
        idx += 1
    return idx


def _parse_debug_reason(raw_payload: str) -> str:
    text = str(raw_payload).strip()
    if not text:
        return "missing"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    reason = str(parsed.get("reason", "")).strip()
    return reason or "missing"


def _pose_sample_from_odometry(msg: Any) -> dict[str, float]:
    return {
        "stamp_s": stamp_to_seconds(msg.header.stamp),
        "x_m": float(msg.pose.pose.position.x),
        "y_m": float(msg.pose.pose.position.y),
        "yaw_deg": quaternion_to_yaw_deg(msg.pose.pose.orientation),
    }


def _yaw_sample_from_imu(msg: Any) -> dict[str, float]:
    return {
        "stamp_s": stamp_to_seconds(msg.header.stamp),
        "yaw_deg": quaternion_to_yaw_deg(msg.orientation),
    }


def load_replay_dataset(bag_path: Path | str) -> dict[str, Any]:
    bag_path = Path(bag_path)
    reader = rosbag2_py.SequentialReader()
    reader.open(
        rosbag2_py.StorageOptions(uri=str(bag_path), storage_id="sqlite3"),
        rosbag2_py.ConverterOptions(
            input_serialization_format="cdr",
            output_serialization_format="cdr",
        ),
    )
    topic_types = {
        topic.name: topic.type for topic in reader.get_all_topics_and_types()
    }
    message_classes = {
        topic: get_message(topic_type) for topic, topic_type in topic_types.items()
    }

    dataset: dict[str, Any] = {
        "bag_path": str(bag_path),
        "series": {name: [] for name in ODOM_TOPICS.values()},
        "series_yaw_only": {"gps_course_heading": []},
        "debug_reason_counts": {},
        "tf_series": {name: [] for name in TF_TARGETS.values()},
    }

    while reader.has_next():
        topic, raw_data, _ = reader.read_next()
        cls = message_classes.get(topic)
        if cls is None:
            continue
        msg = deserialize_message(raw_data, cls)
        if topic in ODOM_TOPICS:
            dataset["series"][ODOM_TOPICS[topic]].append(_pose_sample_from_odometry(msg))
            continue
        if topic == "/gps/course_heading":
            dataset["series_yaw_only"]["gps_course_heading"].append(_yaw_sample_from_imu(msg))
            continue
        if topic == "/gps/course_heading/debug":
            reason = _parse_debug_reason(msg.data)
            counts = dataset["debug_reason_counts"]
            counts[reason] = int(counts.get(reason, 0)) + 1
            continue
        if topic != "/tf":
            continue
        for transform in msg.transforms:
            key = (
                str(transform.header.frame_id).lstrip("/"),
                str(transform.child_frame_id).lstrip("/"),
            )
            target_name = TF_TARGETS.get(key)
            if not target_name:
                continue
            dataset["tf_series"][target_name].append(
                {
                    "stamp_s": stamp_to_seconds(transform.header.stamp),
                    "x_m": float(transform.transform.translation.x),
                    "y_m": float(transform.transform.translation.y),
                    "yaw_deg": quaternion_to_yaw_deg(transform.transform.rotation),
                }
            )

    for series_group in ("series", "series_yaw_only", "tf_series"):
        for samples in dataset[series_group].values():
            samples.sort(key=lambda item: item["stamp_s"])
    dataset["debug_reason_counts"] = dict(sorted(dataset["debug_reason_counts"].items()))
    return dataset


def summarize_pose_series(samples: Sequence[Mapping[str, float]]) -> dict[str, Any]:
    if not samples:
        return {"count": 0}
    x_values = [float(sample["x_m"]) for sample in samples]
    y_values = [float(sample["y_m"]) for sample in samples]
    yaw_values = [float(sample["yaw_deg"]) for sample in samples]
    first = samples[0]
    last = samples[-1]
    return {
        "count": len(samples),
        "duration_s": float(last["stamp_s"]) - float(first["stamp_s"]),
        "start": {
            "stamp_s": float(first["stamp_s"]),
            "x_m": float(first["x_m"]),
            "y_m": float(first["y_m"]),
            "yaw_deg": float(first["yaw_deg"]),
        },
        "end": {
            "stamp_s": float(last["stamp_s"]),
            "x_m": float(last["x_m"]),
            "y_m": float(last["y_m"]),
            "yaw_deg": float(last["yaw_deg"]),
        },
        "delta": {
            "x_m": float(last["x_m"]) - float(first["x_m"]),
            "y_m": float(last["y_m"]) - float(first["y_m"]),
            "yaw_deg": normalize_delta_yaw_deg(float(last["yaw_deg"]) - float(first["yaw_deg"])),
        },
        "x_m": summarize_scalar(x_values),
        "y_m": summarize_scalar(y_values),
        "yaw_deg": summarize_angle(yaw_values),
        "yaw_jumps": summarize_angle_jumps(yaw_values),
    }


def summarize_yaw_series(samples: Sequence[Mapping[str, float]]) -> dict[str, Any]:
    if not samples:
        return {"count": 0}
    yaw_values = [float(sample["yaw_deg"]) for sample in samples]
    first = samples[0]
    last = samples[-1]
    return {
        "count": len(samples),
        "duration_s": float(last["stamp_s"]) - float(first["stamp_s"]),
        "start": {
            "stamp_s": float(first["stamp_s"]),
            "yaw_deg": float(first["yaw_deg"]),
        },
        "end": {
            "stamp_s": float(last["stamp_s"]),
            "yaw_deg": float(last["yaw_deg"]),
        },
        "delta": {
            "yaw_deg": normalize_delta_yaw_deg(float(last["yaw_deg"]) - float(first["yaw_deg"])),
        },
        "yaw_deg": summarize_angle(yaw_values),
        "yaw_jumps": summarize_angle_jumps(yaw_values),
    }


def compare_pose_series(
    recorded: Sequence[Mapping[str, float]],
    replayed: Sequence[Mapping[str, float]],
    *,
    max_time_delta_s: float,
) -> dict[str, Any]:
    if not recorded or not replayed:
        return {
            "count": 0,
            "matched_count": 0,
            "unmatched_count": len(replayed),
        }
    recorded_times = [float(sample["stamp_s"]) for sample in recorded]
    time_deltas = []
    x_deltas = []
    y_deltas = []
    pos_deltas = []
    yaw_deltas = []
    idx = 0
    unmatched = 0
    for sample in replayed:
        idx = _nearest_index(recorded_times, float(sample["stamp_s"]), idx)
        ref = recorded[idx]
        dt = abs(float(sample["stamp_s"]) - float(ref["stamp_s"]))
        if dt > float(max_time_delta_s):
            unmatched += 1
            continue
        time_deltas.append(dt)
        x_delta = float(sample["x_m"]) - float(ref["x_m"])
        y_delta = float(sample["y_m"]) - float(ref["y_m"])
        x_deltas.append(x_delta)
        y_deltas.append(y_delta)
        pos_deltas.append(math.hypot(x_delta, y_delta))
        yaw_deltas.append(
            normalize_delta_yaw_deg(float(sample["yaw_deg"]) - float(ref["yaw_deg"]))
        )
    return {
        "count": len(replayed),
        "matched_count": len(yaw_deltas),
        "unmatched_count": unmatched,
        "max_time_delta_s": max(time_deltas) if time_deltas else None,
        "mean_time_delta_s": (sum(time_deltas) / len(time_deltas)) if time_deltas else None,
        "x_delta_m": summarize_scalar(x_deltas),
        "y_delta_m": summarize_scalar(y_deltas),
        "pos_delta_m": summarize_scalar(pos_deltas),
        "yaw_delta_deg": summarize_scalar(yaw_deltas),
        "yaw_delta_jumps": summarize_angle_jumps(
            yaw_deltas, jump_threshold_deg=DEFAULT_JUMP_THRESHOLD_DEG
        ),
    }


def compare_yaw_series(
    recorded: Sequence[Mapping[str, float]],
    replayed: Sequence[Mapping[str, float]],
    *,
    max_time_delta_s: float,
) -> dict[str, Any]:
    if not recorded or not replayed:
        return {
            "count": 0,
            "matched_count": 0,
            "unmatched_count": len(replayed),
        }
    recorded_times = [float(sample["stamp_s"]) for sample in recorded]
    time_deltas = []
    yaw_deltas = []
    idx = 0
    unmatched = 0
    for sample in replayed:
        idx = _nearest_index(recorded_times, float(sample["stamp_s"]), idx)
        ref = recorded[idx]
        dt = abs(float(sample["stamp_s"]) - float(ref["stamp_s"]))
        if dt > float(max_time_delta_s):
            unmatched += 1
            continue
        time_deltas.append(dt)
        yaw_deltas.append(
            normalize_delta_yaw_deg(float(sample["yaw_deg"]) - float(ref["yaw_deg"]))
        )
    return {
        "count": len(replayed),
        "matched_count": len(yaw_deltas),
        "unmatched_count": unmatched,
        "max_time_delta_s": max(time_deltas) if time_deltas else None,
        "mean_time_delta_s": (sum(time_deltas) / len(time_deltas)) if time_deltas else None,
        "yaw_delta_deg": summarize_scalar(yaw_deltas),
        "yaw_delta_jumps": summarize_angle_jumps(
            yaw_deltas, jump_threshold_deg=DEFAULT_JUMP_THRESHOLD_DEG
        ),
    }


def build_replay_compare_report(
    recorded_dataset: Mapping[str, Any],
    replay_dataset: Mapping[str, Any],
    *,
    max_time_delta_s: float,
) -> dict[str, Any]:
    report = {
        "recorded_bag": str(recorded_dataset["bag_path"]),
        "replay_bag": str(replay_dataset["bag_path"]),
        "max_time_delta_s": float(max_time_delta_s),
        "series": {},
        "debug_reason_counts": {
            "recorded": dict(recorded_dataset["debug_reason_counts"]),
            "replayed": dict(replay_dataset["debug_reason_counts"]),
        },
    }
    for series_name in ("odometry_local", "odometry_global", "gps_odometry_map"):
        recorded_samples = recorded_dataset["series"][series_name]
        replayed_samples = replay_dataset["series"][series_name]
        report["series"][series_name] = {
            "recorded": summarize_pose_series(recorded_samples),
            "replayed": summarize_pose_series(replayed_samples),
            "delta": compare_pose_series(
                recorded_samples,
                replayed_samples,
                max_time_delta_s=max_time_delta_s,
            ),
        }
    for tf_name in ("tf_map_odom", "tf_odom_base_footprint"):
        recorded_samples = recorded_dataset["tf_series"][tf_name]
        replayed_samples = replay_dataset["tf_series"][tf_name]
        report["series"][tf_name] = {
            "recorded": summarize_pose_series(recorded_samples),
            "replayed": summarize_pose_series(replayed_samples),
            "delta": compare_pose_series(
                recorded_samples,
                replayed_samples,
                max_time_delta_s=max_time_delta_s,
            ),
        }
    recorded_heading = recorded_dataset["series_yaw_only"]["gps_course_heading"]
    replayed_heading = replay_dataset["series_yaw_only"]["gps_course_heading"]
    report["series"]["gps_course_heading"] = {
        "recorded": summarize_yaw_series(recorded_heading),
        "replayed": summarize_yaw_series(replayed_heading),
        "delta": compare_yaw_series(
            recorded_heading,
            replayed_heading,
            max_time_delta_s=max_time_delta_s,
        ),
    }
    return json_ready(report)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare a recorded localization bag against an offline replay bag."
    )
    parser.add_argument("--recorded-bag", required=True)
    parser.add_argument("--replay-bag", required=True)
    parser.add_argument("--output", default="")
    parser.add_argument("--max-time-delta-s", type=float, default=0.25)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    recorded_dataset = load_replay_dataset(args.recorded_bag)
    replay_dataset = load_replay_dataset(args.replay_bag)
    report = build_replay_compare_report(
        recorded_dataset,
        replay_dataset,
        max_time_delta_s=max(1.0e-3, float(args.max_time_delta_s)),
    )
    payload = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

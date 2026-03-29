from __future__ import annotations

import argparse
import json
import time
from typing import Any, Optional

import rclpy
from geometry_msgs.msg import TransformStamped
from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from sensor_msgs.msg import Imu
from tf2_ros import Buffer, TransformException, TransformListener

from navegacion_gps.heading_math import AngleSeries
from navegacion_gps.heading_math import circular_mean_deg
from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.heading_math import shortest_angular_distance_deg
from navegacion_gps.heading_math import yaw_deg_from_quaternion_xyzw


EAST_YAW_DEG = 0.0


class StartupHeadingDiagnosisNode(Node):
    def __init__(
        self,
        *,
        imu_topic: str,
        odom_local_topic: str,
        odom_gps_topic: str,
        map_frame: str,
        odom_frame: str,
        base_frame: str,
        tf_sample_hz: float,
    ) -> None:
        super().__init__("startup_heading_diagnosis")
        self.map_frame = str(map_frame)
        self.odom_frame = str(odom_frame)
        self.base_frame = str(base_frame)
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self, spin_thread=False)

        self.imu_yaw = AngleSeries()
        self.local_yaw = AngleSeries()
        self.global_yaw = AngleSeries()
        self.map_to_odom_yaw = AngleSeries()

        self.last_imu_frame_id = ""
        self.last_odom_local_frame_id = ""
        self.last_odom_local_child_frame_id = ""
        self.last_odom_gps_frame_id = ""
        self.last_odom_gps_child_frame_id = ""

        self.create_subscription(Imu, imu_topic, self._on_imu, qos_profile_sensor_data)
        self.create_subscription(Odometry, odom_local_topic, self._on_odom_local, 10)
        self.create_subscription(Odometry, odom_gps_topic, self._on_odom_gps, 10)
        self.create_timer(1.0 / max(1.0, float(tf_sample_hz)), self._sample_tf)

    def _on_imu(self, msg: Imu) -> None:
        try:
            yaw_deg = yaw_deg_from_quaternion_xyzw(
                float(msg.orientation.x),
                float(msg.orientation.y),
                float(msg.orientation.z),
                float(msg.orientation.w),
            )
        except ValueError:
            return
        self.last_imu_frame_id = str(msg.header.frame_id)
        self.imu_yaw.add(yaw_deg)

    def _on_odom_local(self, msg: Odometry) -> None:
        q = msg.pose.pose.orientation
        try:
            yaw_deg = yaw_deg_from_quaternion_xyzw(
                float(q.x),
                float(q.y),
                float(q.z),
                float(q.w),
            )
        except ValueError:
            return
        self.last_odom_local_frame_id = str(msg.header.frame_id)
        self.last_odom_local_child_frame_id = str(msg.child_frame_id)
        self.local_yaw.add(yaw_deg)

    def _on_odom_gps(self, msg: Odometry) -> None:
        self.last_odom_gps_frame_id = str(msg.header.frame_id)
        self.last_odom_gps_child_frame_id = str(msg.child_frame_id)

    def _sample_tf(self) -> None:
        self._sample_transform_yaw(self.map_frame, self.base_frame, self.global_yaw)
        self._sample_transform_yaw(self.map_frame, self.odom_frame, self.map_to_odom_yaw)

    def _sample_transform_yaw(
        self, target_frame: str, source_frame: str, series: AngleSeries
    ) -> None:
        try:
            transform = self.tf_buffer.lookup_transform(
                target_frame,
                source_frame,
                Time(),
                timeout=Duration(seconds=0.05),
            )
        except TransformException:
            return
        try:
            yaw_deg = yaw_deg_from_transform(transform)
        except ValueError:
            return
        series.add(yaw_deg)


def yaw_deg_from_transform(transform: TransformStamped) -> float:
    q = transform.transform.rotation
    return yaw_deg_from_quaternion_xyzw(float(q.x), float(q.y), float(q.z), float(q.w))


def build_report(node: StartupHeadingDiagnosisNode) -> dict[str, Any]:
    imu_summary = node.imu_yaw.summary()
    local_summary = node.local_yaw.summary()
    global_summary = node.global_yaw.summary()
    map_to_odom_summary = node.map_to_odom_yaw.summary()

    imu_mean = imu_summary["mean_deg"]
    local_mean = local_summary["mean_deg"]
    global_mean = global_summary["mean_deg"]
    map_to_odom_mean = map_to_odom_summary["mean_deg"]

    report = {
        "assumption": {
            "spawn_expected_yaw_deg": EAST_YAW_DEG,
            "meaning": "0 deg in ROS ENU means East (+X)",
        },
        "frames": {
            "map_frame": node.map_frame,
            "odom_frame": node.odom_frame,
            "base_frame": node.base_frame,
            "imu_frame_id": node.last_imu_frame_id,
            "odom_local_frame_id": node.last_odom_local_frame_id,
            "odom_local_child_frame_id": node.last_odom_local_child_frame_id,
            "odom_gps_frame_id": node.last_odom_gps_frame_id,
            "odom_gps_child_frame_id": node.last_odom_gps_child_frame_id,
        },
        "yaw_deg": {
            "imu": imu_summary,
            "local": local_summary,
            "global_tf_map_to_base": global_summary,
            "tf_map_to_odom": map_to_odom_summary,
        },
        "errors_deg": {
            "imu_vs_east": (
                shortest_angular_distance_deg(EAST_YAW_DEG, imu_mean)
                if imu_mean is not None
                else None
            ),
            "local_vs_east": (
                shortest_angular_distance_deg(EAST_YAW_DEG, local_mean)
                if local_mean is not None
                else None
            ),
            "global_vs_east": (
                shortest_angular_distance_deg(EAST_YAW_DEG, global_mean)
                if global_mean is not None
                else None
            ),
            "local_minus_imu": (
                shortest_angular_distance_deg(imu_mean, local_mean)
                if imu_mean is not None and local_mean is not None
                else None
            ),
            "global_minus_local": (
                shortest_angular_distance_deg(local_mean, global_mean)
                if local_mean is not None and global_mean is not None
                else None
            ),
            "map_to_odom": map_to_odom_mean,
        },
        "interpretation": [],
    }

    interpretation = report["interpretation"]
    local_vs_east = report["errors_deg"]["local_vs_east"]
    global_vs_east = report["errors_deg"]["global_vs_east"]
    local_minus_imu = report["errors_deg"]["local_minus_imu"]
    global_minus_local = report["errors_deg"]["global_minus_local"]

    if local_vs_east is None:
        interpretation.append("No local odometry yaw available.")
    elif abs(local_vs_east) <= 10.0:
        interpretation.append("Local odometry is close to East at sampling time.")
    else:
        interpretation.append(
            f"Local odometry starts rotated {local_vs_east:.1f} deg relative to East."
        )

    if global_vs_east is None:
        interpretation.append("No map->base TF yaw available.")
    elif abs(global_vs_east) <= 10.0:
        interpretation.append("Global map->base yaw is close to East.")
    else:
        interpretation.append(
            f"Global map->base yaw is rotated {global_vs_east:.1f} deg relative to East."
        )

    if local_minus_imu is None:
        interpretation.append("No IMU/local comparison available.")
    elif abs(local_minus_imu) <= 5.0:
        interpretation.append(
            "Local odometry yaw is almost identical to IMU yaw; startup yaw is likely seeded by the IMU."
        )
    else:
        interpretation.append(
            f"Local odometry differs from IMU by {local_minus_imu:.1f} deg."
        )

    if global_minus_local is None:
        interpretation.append("No global/local comparison available.")
    elif abs(global_minus_local) <= 5.0:
        interpretation.append("Global and local yaw are nearly aligned.")
    else:
        interpretation.append(
            f"Global yaw differs from local yaw by {global_minus_local:.1f} deg."
        )

    return report


def _format_mean(summary: dict[str, Any]) -> str:
    mean = summary.get("mean_deg")
    spread = summary.get("max_abs_error_deg")
    count = int(summary.get("count", 0))
    if mean is None:
        return "N/A"
    return f"{mean:.2f} deg (samples={count}, max_dev={spread:.2f} deg)"


def _print_human_report(report: dict[str, Any]) -> None:
    yaw = report["yaw_deg"]
    errors = report["errors_deg"]
    frames = report["frames"]
    print("Startup heading diagnosis")
    print(f"- Assumption: spawn/model should face East ({report['assumption']['spawn_expected_yaw_deg']:.1f} deg ROS ENU)")
    print(
        f"- Frames: map={frames['map_frame']} odom={frames['odom_frame']} "
        f"base={frames['base_frame']} imu_frame={frames['imu_frame_id'] or 'N/A'}"
    )
    print(f"- IMU yaw: {_format_mean(yaw['imu'])}")
    print(f"- Local odom yaw: {_format_mean(yaw['local'])}")
    print(f"- Global map->base yaw: {_format_mean(yaw['global_tf_map_to_base'])}")
    print(f"- TF map->odom yaw: {_format_mean(yaw['tf_map_to_odom'])}")
    print(
        "- Errors: "
        f"imu_vs_east={_fmt_optional(errors['imu_vs_east'])}, "
        f"local_vs_east={_fmt_optional(errors['local_vs_east'])}, "
        f"global_vs_east={_fmt_optional(errors['global_vs_east'])}, "
        f"local_minus_imu={_fmt_optional(errors['local_minus_imu'])}, "
        f"global_minus_local={_fmt_optional(errors['global_minus_local'])}"
    )
    print("- Interpretation:")
    for line in report["interpretation"]:
        print(f"  * {line}")


def _fmt_optional(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"{value:.2f} deg"


def _parse_args(args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Diagnose startup yaw alignment between IMU, local odometry, and global TF."
    )
    parser.add_argument("--imu-topic", default="/imu/data")
    parser.add_argument("--odom-local-topic", default="/odometry/local")
    parser.add_argument("--odom-gps-topic", default="/odometry/gps")
    parser.add_argument("--map-frame", default="map")
    parser.add_argument("--odom-frame", default="odom")
    parser.add_argument("--base-frame", default="base_footprint")
    parser.add_argument("--window-sec", type=float, default=3.0)
    parser.add_argument("--timeout-sec", type=float, default=8.0)
    parser.add_argument("--tf-sample-hz", type=float, default=10.0)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(args)


def main(argv: Optional[list[str]] = None) -> int:
    cli_args = _parse_args(rclpy.utilities.remove_ros_args(args=argv)[1:])
    rclpy.init(args=argv)
    node = StartupHeadingDiagnosisNode(
        imu_topic=cli_args.imu_topic,
        odom_local_topic=cli_args.odom_local_topic,
        odom_gps_topic=cli_args.odom_gps_topic,
        map_frame=cli_args.map_frame,
        odom_frame=cli_args.odom_frame,
        base_frame=cli_args.base_frame,
        tf_sample_hz=cli_args.tf_sample_hz,
    )
    try:
        deadline = time.time() + max(0.5, float(cli_args.timeout_sec))
        while time.time() < deadline:
            rclpy.spin_once(node, timeout_sec=0.1)
            if node.imu_yaw.values_deg and node.local_yaw.values_deg:
                break
        sample_end = time.time() + max(0.5, float(cli_args.window_sec))
        while time.time() < sample_end:
            rclpy.spin_once(node, timeout_sec=0.1)
        report = build_report(node)
        if cli_args.json:
            print(json.dumps(report, indent=2, sort_keys=True))
        else:
            _print_human_report(report)
        has_local = report["yaw_deg"]["local"]["mean_deg"] is not None
        has_global = report["yaw_deg"]["global_tf_map_to_base"]["mean_deg"] is not None
        return 0 if has_local or has_global else 2
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())

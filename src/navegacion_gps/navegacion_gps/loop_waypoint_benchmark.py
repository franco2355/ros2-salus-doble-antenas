from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from typing import Optional

from interfaces.srv import SetNavGoalLL
from nav_msgs.msg import Odometry
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import NavSatFix
from tf2_msgs.msg import TFMessage
import yaml

from navegacion_gps.heading_math import normalize_yaw_deg
from navegacion_gps.heading_math import yaw_deg_from_quaternion_xyzw
from navegacion_gps.loop_waypoint_benchmark_core import build_block_loop_waypoints
from navegacion_gps.loop_waypoint_benchmark_core import build_waypoints_yaml_document


class LoopWaypointBenchmarkNode(Node):
    def __init__(self) -> None:
        super().__init__("loop_waypoint_benchmark")

        self.gps_fix: Optional[NavSatFix] = None
        self.odom_local: Optional[Odometry] = None
        self.latest_map_odom_tf: Optional[dict[str, float]] = None

        self.create_subscription(NavSatFix, "/gps/fix", self._on_gps_fix, 10)
        self.create_subscription(Odometry, "/odometry/local", self._on_odom_local, 10)
        self.create_subscription(TFMessage, "/tf", self._on_tf, 100)

        self.goal_client = self.create_client(SetNavGoalLL, "/nav_command_server/set_goal_ll")

    def _on_gps_fix(self, msg: NavSatFix) -> None:
        self.gps_fix = msg

    def _on_odom_local(self, msg: Odometry) -> None:
        self.odom_local = msg

    def _on_tf(self, msg: TFMessage) -> None:
        for transform in msg.transforms:
            if transform.header.frame_id != "map" or transform.child_frame_id != "odom":
                continue
            rotation = transform.transform.rotation
            self.latest_map_odom_tf = {
                "x": float(transform.transform.translation.x),
                "y": float(transform.transform.translation.y),
                "yaw_deg": float(
                    yaw_deg_from_quaternion_xyzw(
                        rotation.x,
                        rotation.y,
                        rotation.z,
                        rotation.w,
                    )
                ),
            }

    def spin_until(self, predicate, timeout_s: float) -> bool:
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if predicate():
                return True
        return False

    def wait_for_bootstrap(self, timeout_s: float) -> bool:
        if not self.goal_client.wait_for_service(timeout_sec=timeout_s):
            return False
        return self.spin_until(
            lambda: self.gps_fix is not None
            and self.odom_local is not None
            and self.latest_map_odom_tf is not None,
            timeout_s=timeout_s,
        )

    def current_reference(self) -> dict[str, float]:
        if self.gps_fix is None or self.odom_local is None or self.latest_map_odom_tf is None:
            raise RuntimeError("benchmark reference is not ready")

        odom_local_yaw_deg = yaw_deg_from_quaternion_xyzw(
            self.odom_local.pose.pose.orientation.x,
            self.odom_local.pose.pose.orientation.y,
            self.odom_local.pose.pose.orientation.z,
            self.odom_local.pose.pose.orientation.w,
        )
        map_yaw_deg = float(self.latest_map_odom_tf["yaw_deg"])
        return {
            "lat": float(self.gps_fix.latitude),
            "lon": float(self.gps_fix.longitude),
            "yaw_deg": float(normalize_yaw_deg(map_yaw_deg + odom_local_yaw_deg)),
        }

    def send_loop_goal(
        self,
        *,
        waypoints: list[dict[str, float]],
        timeout_s: float,
    ) -> dict[str, object]:
        request = SetNavGoalLL.Request()
        request.lats = [float(item["lat"]) for item in waypoints]
        request.lons = [float(item["lon"]) for item in waypoints]
        request.yaws_deg = [float(item["yaw_deg"]) for item in waypoints]
        request.loop = True
        future = self.goal_client.call_async(request)
        end = time.time() + float(timeout_s)
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            if future.done():
                response = future.result()
                return {"ok": bool(response.ok), "error": str(response.error)}
        raise RuntimeError("timeout waiting for /nav_command_server/set_goal_ll response")


def _write_yaml_file(path: Path, waypoints: list[dict[str, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(build_waypoints_yaml_document(waypoints), sort_keys=False),
        encoding="utf-8",
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate a 4-waypoint block loop benchmark relative to current pose."
    )
    parser.add_argument("--long-edge-m", type=float, default=35.0)
    parser.add_argument("--short-edge-m", type=float, default=18.0)
    parser.add_argument("--turn-direction", choices=("left", "right"), default="left")
    parser.add_argument("--output", type=str, default="")
    parser.add_argument("--write-saved-waypoints", type=str, default="")
    parser.add_argument("--send-goal", action="store_true")
    parser.add_argument("--timeout-s", type=float, default=15.0)
    args = parser.parse_args(argv)

    rclpy.init(args=None)
    node = LoopWaypointBenchmarkNode()
    try:
        if not node.wait_for_bootstrap(timeout_s=float(args.timeout_s)):
            raise RuntimeError("timeout waiting for gps/odom/tf bootstrap")

        reference = node.current_reference()
        waypoints = build_block_loop_waypoints(
            start_lat=float(reference["lat"]),
            start_lon=float(reference["lon"]),
            start_yaw_deg=float(reference["yaw_deg"]),
            long_edge_m=float(args.long_edge_m),
            short_edge_m=float(args.short_edge_m),
            turn_direction=str(args.turn_direction),
        )

        output_payload: dict[str, object] = {
            "reference": reference,
            "long_edge_m": float(args.long_edge_m),
            "short_edge_m": float(args.short_edge_m),
            "turn_direction": str(args.turn_direction),
            "loop": True,
            "waypoints": waypoints,
        }

        if args.output:
            output_path = Path(str(args.output)).expanduser()
            _write_yaml_file(output_path, waypoints)
            output_payload["output"] = str(output_path)
            node.get_logger().info(f"benchmark waypoints written to {output_path}")

        if args.write_saved_waypoints:
            saved_path = Path(str(args.write_saved_waypoints)).expanduser()
            _write_yaml_file(saved_path, waypoints)
            output_payload["saved_waypoints_output"] = str(saved_path)
            node.get_logger().info(f"saved waypoints updated at {saved_path}")

        if bool(args.send_goal):
            result = node.send_loop_goal(waypoints=waypoints, timeout_s=float(args.timeout_s))
            output_payload["set_goal_result"] = result
            if not bool(result.get("ok", False)):
                raise RuntimeError(f"set_goal_ll failed: {result.get('error', 'unknown')}")

        print(json.dumps(output_payload, ensure_ascii=True, indent=2))
        return 0
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())

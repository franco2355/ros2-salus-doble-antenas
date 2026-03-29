from __future__ import annotations

import math
from typing import Optional

import rclpy
from interfaces.msg import DriveTelemetry
from nav_msgs.msg import Odometry
from rclpy.node import Node
from sensor_msgs.msg import JointState


class SimDriveTelemetryNode(Node):
    def __init__(self) -> None:
        super().__init__("sim_drive_telemetry")

        self.declare_parameter("odom_topic", "/odom_raw")
        self.declare_parameter("joint_states_topic", "/joint_states")
        self.declare_parameter("drive_telemetry_topic", "/controller/drive_telemetry")
        self.declare_parameter("front_left_steer_joint", "front_left_steer_joint")
        self.declare_parameter("front_right_steer_joint", "front_right_steer_joint")
        self.declare_parameter("wheelbase_m", 0.94)
        self.declare_parameter("steer_from_odom_min_speed_mps", 0.05)

        odom_topic = str(self.get_parameter("odom_topic").value)
        joint_states_topic = str(self.get_parameter("joint_states_topic").value)
        drive_telemetry_topic = str(
            self.get_parameter("drive_telemetry_topic").value
        )
        self._front_left_steer_joint = str(
            self.get_parameter("front_left_steer_joint").value
        )
        self._front_right_steer_joint = str(
            self.get_parameter("front_right_steer_joint").value
        )
        self._wheelbase_m = max(1.0e-6, float(self.get_parameter("wheelbase_m").value))
        self._steer_from_odom_min_speed_mps = max(
            0.0, float(self.get_parameter("steer_from_odom_min_speed_mps").value)
        )

        self._latest_steer_rad: Optional[float] = None
        self._pub = self.create_publisher(DriveTelemetry, drive_telemetry_topic, 10)
        self.create_subscription(JointState, joint_states_topic, self._on_joint_states, 10)
        self.create_subscription(Odometry, odom_topic, self._on_odom, 10)

        self.get_logger().info(
            "sim_drive_telemetry ready "
            f"({odom_topic} + {joint_states_topic} -> {drive_telemetry_topic})"
        )

    def _on_joint_states(self, msg: JointState) -> None:
        positions_by_name = dict(zip(msg.name, msg.position))
        steer_samples = []
        for joint_name in (
            self._front_left_steer_joint,
            self._front_right_steer_joint,
        ):
            if joint_name in positions_by_name:
                steer_samples.append(float(positions_by_name[joint_name]))
        if steer_samples:
            self._latest_steer_rad = sum(steer_samples) / float(len(steer_samples))

    def _on_odom(self, msg: Odometry) -> None:
        linear_x = float(msg.twist.twist.linear.x)
        linear_y = float(msg.twist.twist.linear.y)
        angular_z = float(msg.twist.twist.angular.z)
        speed_mps = math.hypot(linear_x, linear_y)
        steer_rad = self._latest_steer_rad
        signed_speed_mps = float(linear_x)
        if abs(signed_speed_mps) >= self._steer_from_odom_min_speed_mps:
            steer_rad = math.atan2(
                self._wheelbase_m * angular_z,
                signed_speed_mps,
            )
        telemetry = DriveTelemetry()
        telemetry.stamp = msg.header.stamp
        telemetry.ready = True
        telemetry.fresh = True
        telemetry.drive_enabled = True
        telemetry.estop = False
        telemetry.reverse_requested = linear_x < 0.0
        telemetry.speed_valid = math.isfinite(speed_mps)
        telemetry.steer_valid = steer_rad is not None and math.isfinite(float(steer_rad))
        telemetry.control_source = "SIM"
        telemetry.speed_mps_measured = float(speed_mps) if telemetry.speed_valid else 0.0
        telemetry.steer_deg_measured = (
            math.degrees(float(steer_rad))
            if telemetry.steer_valid
            else 0.0
        )
        telemetry.brake_applied_pct = 0
        self._pub.publish(telemetry)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = SimDriveTelemetryNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

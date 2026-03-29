from __future__ import annotations

import math
from typing import Optional

import rclpy
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import Point, Pose, PoseStamped, Quaternion, Twist
from nav2_msgs.action import FollowPath
from nav_msgs.msg import Odometry, Path
from rclpy.action import ActionClient
from rclpy.node import Node
from std_msgs.msg import Empty
from tf2_geometry_msgs import do_transform_pose_stamped
from tf2_ros import Buffer, TransformException, TransformListener
from visualization_msgs.msg import Marker, MarkerArray


def yaw_from_quaternion(quaternion: Quaternion) -> float:
    siny_cosp = 2.0 * (
        float(quaternion.w) * float(quaternion.z)
        + float(quaternion.x) * float(quaternion.y)
    )
    cosy_cosp = 1.0 - 2.0 * (
        float(quaternion.y) * float(quaternion.y)
        + float(quaternion.z) * float(quaternion.z)
    )
    return math.atan2(siny_cosp, cosy_cosp)


def quaternion_from_yaw(yaw_rad: float) -> Quaternion:
    half_yaw = 0.5 * float(yaw_rad)
    quaternion = Quaternion()
    quaternion.w = math.cos(half_yaw)
    quaternion.x = 0.0
    quaternion.y = 0.0
    quaternion.z = math.sin(half_yaw)
    return quaternion


def normalize_angle(angle_rad: float) -> float:
    while angle_rad <= -math.pi:
        angle_rad += 2.0 * math.pi
    while angle_rad > math.pi:
        angle_rad -= 2.0 * math.pi
    return angle_rad


def build_ackermann_path(
    start_pose: Pose,
    goal_pose: Pose,
    frame_id: str,
    step_distance_m: float,
    min_intermediate_poses: int,
    use_goal_orientation: bool = True,
    turning_radius_m: float = 2.4,
) -> Path:
    path = Path()
    path.header.frame_id = str(frame_id)

    dx_m = float(goal_pose.position.x) - float(start_pose.position.x)
    dy_m = float(goal_pose.position.y) - float(start_pose.position.y)
    distance_m = math.hypot(dx_m, dy_m)
    heading_rad = (
        math.atan2(dy_m, dx_m)
        if distance_m > 1.0e-6
        else yaw_from_quaternion(goal_pose.orientation)
    )
    start_yaw_rad = yaw_from_quaternion(start_pose.orientation)
    goal_yaw_rad = (
        yaw_from_quaternion(goal_pose.orientation)
        if use_goal_orientation
        else heading_rad
    )

    if distance_m <= 1.0e-6:
        pose_stamped = PoseStamped()
        pose_stamped.header.frame_id = str(frame_id)
        pose_stamped.pose = goal_pose
        path.poses.append(pose_stamped)
        return path

    safe_step = max(0.05, float(step_distance_m))

    def append_pose(x_world: float, y_world: float, yaw_world_rad: float) -> None:
        pose_stamped = PoseStamped()
        pose_stamped.header.frame_id = str(frame_id)
        pose_stamped.pose.position.x = float(x_world)
        pose_stamped.pose.position.y = float(y_world)
        pose_stamped.pose.position.z = 0.0
        pose_stamped.pose.orientation = quaternion_from_yaw(yaw_world_rad)
        path.poses.append(pose_stamped)

    if not use_goal_orientation:
        cos_start = math.cos(start_yaw_rad)
        sin_start = math.sin(start_yaw_rad)
        goal_local_x = cos_start * dx_m + sin_start * dy_m
        goal_local_y = -sin_start * dx_m + cos_start * dy_m

        if goal_local_x > 0.0 and abs(goal_local_y) <= 1.0e-6:
            segment_count = max(
                int(math.ceil(distance_m / safe_step)),
                int(min_intermediate_poses),
            )
            for index in range(segment_count + 1):
                ratio = float(index) / float(segment_count)
                append_pose(
                    x_world=float(start_pose.position.x) + ratio * dx_m,
                    y_world=float(start_pose.position.y) + ratio * dy_m,
                    yaw_world_rad=heading_rad,
                )
            return path

        turn_sign = 1.0 if goal_local_y >= 0.0 else -1.0
        mirrored_goal_y = turn_sign * goal_local_y
        turning_radius = max(0.1, float(turning_radius_m))
        circle_to_goal_x = goal_local_x
        circle_to_goal_y = mirrored_goal_y - turning_radius
        circle_to_goal_distance = math.hypot(circle_to_goal_x, circle_to_goal_y)

        if circle_to_goal_distance > turning_radius + 1.0e-6:
            gamma = math.atan2(circle_to_goal_y, circle_to_goal_x)
            beta = math.acos(
                max(-1.0, min(1.0, turning_radius / circle_to_goal_distance))
            )
            candidate_alphas = [gamma - beta, gamma + beta]

            for alpha in candidate_alphas:
                turn_angle = alpha + 0.5 * math.pi
                if not (0.0 <= turn_angle <= math.pi):
                    continue

                tangent_x = turning_radius * math.sin(turn_angle)
                tangent_y = turning_radius * (1.0 - math.cos(turn_angle))
                straight_dx = circle_to_goal_x - tangent_x
                straight_dy = mirrored_goal_y - tangent_y
                straight_length = (
                    straight_dx * math.cos(turn_angle)
                    + straight_dy * math.sin(turn_angle)
                )
                lateral_error = abs(
                    -straight_dx * math.sin(turn_angle)
                    + straight_dy * math.cos(turn_angle)
                )
                if straight_length < -1.0e-6 or lateral_error > 1.0e-3:
                    continue

                arc_length = turning_radius * turn_angle
                arc_steps = max(
                    int(math.ceil(arc_length / safe_step)),
                    1,
                )
                line_steps = max(
                    int(math.ceil(max(0.0, straight_length) / safe_step)),
                    1 if straight_length > 1.0e-6 else 0,
                )

                for index in range(arc_steps + 1):
                    ratio = float(index) / float(arc_steps)
                    arc_heading = turn_sign * turn_angle * ratio
                    arc_x = turning_radius * math.sin(turn_angle * ratio)
                    arc_y = turn_sign * turning_radius * (
                        1.0 - math.cos(turn_angle * ratio)
                    )
                    append_pose(
                        x_world=float(start_pose.position.x)
                        + cos_start * arc_x
                        - sin_start * arc_y,
                        y_world=float(start_pose.position.y)
                        + sin_start * arc_x
                        + cos_start * arc_y,
                        yaw_world_rad=normalize_angle(start_yaw_rad + arc_heading),
                    )

                for index in range(1, line_steps + 1):
                    ratio = float(index) / float(line_steps)
                    line_distance = straight_length * ratio
                    line_x = tangent_x + line_distance * math.cos(turn_angle)
                    line_y = turn_sign * (
                        tangent_y + line_distance * math.sin(turn_angle)
                    )
                    append_pose(
                        x_world=float(start_pose.position.x)
                        + cos_start * line_x
                        - sin_start * line_y,
                        y_world=float(start_pose.position.y)
                        + sin_start * line_x
                        + cos_start * line_y,
                        yaw_world_rad=normalize_angle(
                            start_yaw_rad + turn_sign * turn_angle
                        ),
                    )

                if path.poses:
                    path.poses[-1].pose.position.x = float(goal_pose.position.x)
                    path.poses[-1].pose.position.y = float(goal_pose.position.y)
                    path.poses[-1].pose.orientation = quaternion_from_yaw(
                        normalize_angle(start_yaw_rad + turn_sign * turn_angle)
                    )
                return path

    segment_count = max(
        int(math.ceil(distance_m / safe_step)),
        int(min_intermediate_poses),
    )
    start_heading_error_rad = normalize_angle(start_yaw_rad - heading_rad)
    goal_heading_error_rad = normalize_angle(goal_yaw_rad - heading_rad)
    aligned_with_goal_heading = (
        abs(start_heading_error_rad) <= math.radians(12.0)
        and abs(goal_heading_error_rad) <= math.radians(12.0)
    )

    if aligned_with_goal_heading:
        for index in range(segment_count + 1):
            ratio = float(index) / float(segment_count)
            pose_stamped = PoseStamped()
            pose_stamped.header.frame_id = str(frame_id)
            pose_stamped.pose.position.x = (
                float(start_pose.position.x) + ratio * dx_m
            )
            pose_stamped.pose.position.y = (
                float(start_pose.position.y) + ratio * dy_m
            )
            pose_stamped.pose.position.z = 0.0
            pose_stamped.pose.orientation = quaternion_from_yaw(heading_rad)
            path.poses.append(pose_stamped)

        if use_goal_orientation and path.poses:
            path.poses[-1].pose.orientation = goal_pose.orientation
        return path

    max_heading_error_rad = max(
        abs(start_heading_error_rad),
        abs(goal_heading_error_rad),
    )
    heading_weight = min(1.0, max_heading_error_rad / math.radians(90.0))
    control_distance_m = max(
        0.20,
        min(distance_m * (0.18 + 0.22 * heading_weight), 1.0),
    )

    p0_x = float(start_pose.position.x)
    p0_y = float(start_pose.position.y)
    p1_x = p0_x + control_distance_m * math.cos(start_yaw_rad)
    p1_y = p0_y + control_distance_m * math.sin(start_yaw_rad)
    p3_x = float(goal_pose.position.x)
    p3_y = float(goal_pose.position.y)
    p2_x = p3_x - control_distance_m * math.cos(goal_yaw_rad)
    p2_y = p3_y - control_distance_m * math.sin(goal_yaw_rad)

    for index in range(segment_count + 1):
        ratio = float(index) / float(segment_count)
        one_minus_ratio = 1.0 - ratio
        x_value = (
            (one_minus_ratio**3) * p0_x
            + 3.0 * (one_minus_ratio**2) * ratio * p1_x
            + 3.0 * one_minus_ratio * (ratio**2) * p2_x
            + (ratio**3) * p3_x
        )
        y_value = (
            (one_minus_ratio**3) * p0_y
            + 3.0 * (one_minus_ratio**2) * ratio * p1_y
            + 3.0 * one_minus_ratio * (ratio**2) * p2_y
            + (ratio**3) * p3_y
        )
        tangent_x = (
            3.0 * (one_minus_ratio**2) * (p1_x - p0_x)
            + 6.0 * one_minus_ratio * ratio * (p2_x - p1_x)
            + 3.0 * (ratio**2) * (p3_x - p2_x)
        )
        tangent_y = (
            3.0 * (one_minus_ratio**2) * (p1_y - p0_y)
            + 6.0 * one_minus_ratio * ratio * (p2_y - p1_y)
            + 3.0 * (ratio**2) * (p3_y - p2_y)
        )
        tangent_norm = math.hypot(tangent_x, tangent_y)
        tangent_yaw_rad = (
            math.atan2(tangent_y, tangent_x)
            if tangent_norm > 1.0e-6
            else heading_rad
        )
        append_pose(
            x_world=x_value,
            y_world=y_value,
            yaw_world_rad=tangent_yaw_rad,
        )

    if use_goal_orientation and path.poses:
        path.poses[-1].pose.orientation = goal_pose.orientation

    return path


def distance_xy(first_pose: Pose, second_pose: Pose) -> float:
    return math.hypot(
        float(second_pose.position.x) - float(first_pose.position.x),
        float(second_pose.position.y) - float(first_pose.position.y),
    )


def minimum_distance_to_path_xy(path: Path, pose: Pose) -> float:
    if not path.poses:
        return float("inf")
    return min(distance_xy(path_pose.pose, pose) for path_pose in path.poses)


def closest_path_pose(path: Path, pose: Pose) -> Optional[PoseStamped]:
    if not path.poses:
        return None
    return min(path.poses, key=lambda path_pose: distance_xy(path_pose.pose, pose))


class GoalPoseToFollowPathV2(Node):
    def __init__(self) -> None:
        super().__init__("goal_pose_to_follow_path_v2")

        self.declare_parameter("goal_topic", "/goal_pose")
        self.declare_parameter("odom_topic", "/odometry/local")
        self.declare_parameter("action_name", "/follow_path")
        self.declare_parameter("path_frame", "odom")
        self.declare_parameter("controller_id", "FollowPath")
        self.declare_parameter("goal_checker_id", "general_goal_checker")
        self.declare_parameter("path_topic", "/goal_pose_path")
        self.declare_parameter("step_distance_m", 0.10)
        self.declare_parameter("min_intermediate_poses", 6)
        self.declare_parameter("turning_radius_m", 2.4)
        self.declare_parameter("transform_timeout_s", 0.2)
        self.declare_parameter("use_goal_orientation", True)
        self.declare_parameter("stop_hold_topic", "/local_nav_v2/stop_hold")
        self.declare_parameter("path_monitor_hz", 5.0)
        self.declare_parameter("path_replan_distance_m", 0.9)
        self.declare_parameter("path_replan_min_goal_distance_m", 1.0)
        self.declare_parameter("path_replan_min_goal_age_s", 1.0)
        self.declare_parameter("path_replan_cooldown_s", 1.5)
        self.declare_parameter("debug_markers_topic", "/local_nav_v2/path_tracking_debug")
        self.declare_parameter("debug_log_period_s", 1.0)
        self.declare_parameter("cmd_vel_safe_topic", "/cmd_vel_safe")
        self.declare_parameter("odom_raw_topic", "/odom_raw")

        goal_topic = str(self.get_parameter("goal_topic").value)
        odom_topic = str(self.get_parameter("odom_topic").value)
        action_name = str(self.get_parameter("action_name").value)
        path_topic = str(self.get_parameter("path_topic").value)
        stop_hold_topic = str(self.get_parameter("stop_hold_topic").value)
        debug_markers_topic = str(self.get_parameter("debug_markers_topic").value)
        cmd_vel_safe_topic = str(self.get_parameter("cmd_vel_safe_topic").value)
        odom_raw_topic = str(self.get_parameter("odom_raw_topic").value)

        self._path_frame = str(self.get_parameter("path_frame").value)
        self._controller_id = str(self.get_parameter("controller_id").value)
        self._goal_checker_id = str(self.get_parameter("goal_checker_id").value)
        self._step_distance_m = float(self.get_parameter("step_distance_m").value)
        self._min_intermediate_poses = int(
            self.get_parameter("min_intermediate_poses").value
        )
        self._turning_radius_m = max(
            0.1,
            float(self.get_parameter("turning_radius_m").value),
        )
        self._transform_timeout_s = float(
            self.get_parameter("transform_timeout_s").value
        )
        self._use_goal_orientation = bool(
            self.get_parameter("use_goal_orientation").value
        )
        self._path_replan_distance_m = max(
            0.1, float(self.get_parameter("path_replan_distance_m").value)
        )
        self._path_replan_min_goal_distance_m = max(
            0.1,
            float(self.get_parameter("path_replan_min_goal_distance_m").value),
        )
        self._path_replan_min_goal_age_s = max(
            0.0,
            float(self.get_parameter("path_replan_min_goal_age_s").value),
        )
        self._path_replan_cooldown_s = max(
            0.1,
            float(self.get_parameter("path_replan_cooldown_s").value),
        )
        self._debug_log_period_s = max(
            0.2, float(self.get_parameter("debug_log_period_s").value)
        )
        path_monitor_hz = max(
            1.0, float(self.get_parameter("path_monitor_hz").value)
        )

        self._latest_pose: Optional[PoseStamped] = None
        self._latest_goal_handle = None
        self._active_goal_pose: Optional[PoseStamped] = None
        self._active_path: Optional[Path] = None
        self._active_goal_sent_ns: int = 0
        self._replan_pending = False
        self._ignore_next_canceled_result = False
        self._next_replan_allowed_ns = 0
        self._latest_cmd_vel_nav = Twist()
        self._latest_cmd_vel_safe = Twist()
        self._latest_odom_raw = Odometry()
        self._last_debug_log_ns = 0

        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self)
        self._follow_path_client = ActionClient(self, FollowPath, action_name)

        self._path_pub = self.create_publisher(Path, path_topic, 10)
        self._stop_hold_pub = self.create_publisher(Empty, stop_hold_topic, 10)
        self._debug_markers_pub = self.create_publisher(
            MarkerArray, debug_markers_topic, 10
        )
        self.create_subscription(Odometry, odom_topic, self._on_odometry, 10)
        self.create_subscription(PoseStamped, goal_topic, self._on_goal_pose, 10)
        self.create_subscription(Twist, "/cmd_vel_nav", self._on_cmd_vel_nav, 10)
        self.create_subscription(Twist, cmd_vel_safe_topic, self._on_cmd_vel_safe, 10)
        self.create_subscription(Odometry, odom_raw_topic, self._on_odom_raw, 10)
        self.create_timer(1.0 / path_monitor_hz, self._on_path_monitor_timer)

        self.get_logger().info(
            "goal_pose_to_follow_path_v2 ready "
            f"({goal_topic} -> {action_name}, frame={self._path_frame})"
        )

    def _on_odometry(self, msg: Odometry) -> None:
        pose_stamped = PoseStamped()
        pose_stamped.header = msg.header
        pose_stamped.pose = msg.pose.pose
        self._latest_pose = pose_stamped

    def _on_cmd_vel_nav(self, msg: Twist) -> None:
        self._latest_cmd_vel_nav = msg

    def _on_cmd_vel_safe(self, msg: Twist) -> None:
        self._latest_cmd_vel_safe = msg

    def _on_odom_raw(self, msg: Odometry) -> None:
        self._latest_odom_raw = msg

    def _transform_pose(self, pose: PoseStamped) -> Optional[PoseStamped]:
        if pose.header.frame_id == self._path_frame:
            return pose

        try:
            transform = self._tf_buffer.lookup_transform(
                self._path_frame,
                pose.header.frame_id,
                rclpy.time.Time(),
                timeout=rclpy.duration.Duration(seconds=self._transform_timeout_s),
            )
        except TransformException as exc:
            self.get_logger().warning(
                f"No pude transformar {pose.header.frame_id} -> {self._path_frame}: {exc}"
            )
            return None

        return do_transform_pose_stamped(pose, transform)

    def _on_goal_pose(self, msg: PoseStamped) -> None:
        if self._latest_pose is None:
            self.get_logger().warning(
                "Ignorando /goal_pose: todavia no hay /odometry/local disponible"
            )
            return

        current_pose = self._transform_pose(self._latest_pose)
        goal_pose = self._transform_pose(msg)
        if current_pose is None or goal_pose is None:
            return

        self._send_follow_path_goal(
            current_pose=current_pose,
            goal_pose=goal_pose,
            log_reason="RViz",
        )

    def _send_follow_path_goal(
        self,
        *,
        current_pose: PoseStamped,
        goal_pose: PoseStamped,
        log_reason: str,
    ) -> None:
        self._replan_pending = False

        path = build_ackermann_path(
            start_pose=current_pose.pose,
            goal_pose=goal_pose.pose,
            frame_id=self._path_frame,
            step_distance_m=self._step_distance_m,
            min_intermediate_poses=self._min_intermediate_poses,
            use_goal_orientation=self._use_goal_orientation,
            turning_radius_m=self._turning_radius_m,
        )
        path.header.stamp = self.get_clock().now().to_msg()
        for pose in path.poses:
            pose.header.stamp = path.header.stamp
        self._path_pub.publish(path)
        self._active_goal_pose = goal_pose
        self._active_path = path
        self._active_goal_sent_ns = self.get_clock().now().nanoseconds

        if not self._follow_path_client.wait_for_server(timeout_sec=1.0):
            self.get_logger().warning("El action server /follow_path no esta disponible")
            return

        goal = FollowPath.Goal()
        goal.path = path
        goal.controller_id = self._controller_id
        goal.goal_checker_id = self._goal_checker_id

        self.get_logger().info(
            f"Enviando goal {log_reason} a FollowPath "
            f"(poses={len(path.poses)}, x={goal_pose.pose.position.x:.2f}, "
            f"y={goal_pose.pose.position.y:.2f})"
        )

        send_goal_future = self._follow_path_client.send_goal_async(goal)
        send_goal_future.add_done_callback(self._on_goal_response)

    def _active_goal_running(self) -> bool:
        return self._latest_goal_handle is not None and bool(self._latest_goal_handle.accepted)

    def _publish_debug_markers(
        self,
        *,
        current_pose: PoseStamped,
        closest_pose: PoseStamped,
        distance_to_path_m: float,
        heading_error_rad: float,
    ) -> None:
        marker_array = MarkerArray()

        closest_marker = Marker()
        closest_marker.header.frame_id = self._path_frame
        closest_marker.header.stamp = self.get_clock().now().to_msg()
        closest_marker.ns = "path_tracking_debug"
        closest_marker.id = 0
        closest_marker.type = Marker.SPHERE
        closest_marker.action = Marker.ADD
        closest_marker.pose.position.x = float(closest_pose.pose.position.x)
        closest_marker.pose.position.y = float(closest_pose.pose.position.y)
        closest_marker.pose.position.z = 0.08
        closest_marker.pose.orientation.w = 1.0
        closest_marker.scale.x = 0.18
        closest_marker.scale.y = 0.18
        closest_marker.scale.z = 0.18
        closest_marker.color.a = 0.95
        closest_marker.color.r = 1.0
        closest_marker.color.g = 0.9
        closest_marker.color.b = 0.0
        marker_array.markers.append(closest_marker)

        line_marker = Marker()
        line_marker.header = closest_marker.header
        line_marker.ns = "path_tracking_debug"
        line_marker.id = 1
        line_marker.type = Marker.LINE_STRIP
        line_marker.action = Marker.ADD
        line_marker.scale.x = 0.05
        line_marker.color.a = 0.95
        line_marker.color.r = 1.0
        line_marker.color.g = 0.4
        line_marker.color.b = 0.0
        current_point = Point()
        current_point.x = float(current_pose.pose.position.x)
        current_point.y = float(current_pose.pose.position.y)
        current_point.z = 0.06
        closest_point = Point()
        closest_point.x = float(closest_pose.pose.position.x)
        closest_point.y = float(closest_pose.pose.position.y)
        closest_point.z = 0.06
        line_marker.points = [current_point, closest_point]
        marker_array.markers.append(line_marker)

        text_marker = Marker()
        text_marker.header = closest_marker.header
        text_marker.ns = "path_tracking_debug"
        text_marker.id = 2
        text_marker.type = Marker.TEXT_VIEW_FACING
        text_marker.action = Marker.ADD
        text_marker.pose.position.x = float(current_pose.pose.position.x)
        text_marker.pose.position.y = float(current_pose.pose.position.y)
        text_marker.pose.position.z = 0.8
        text_marker.pose.orientation.w = 1.0
        text_marker.scale.z = 0.28
        text_marker.color.a = 1.0
        text_marker.color.r = 1.0
        text_marker.color.g = 1.0
        text_marker.color.b = 1.0
        text_marker.text = (
            f"d={distance_to_path_m:.2f} m\n"
            f"yaw_err={math.degrees(heading_error_rad):.1f} deg\n"
            f"nav_wz={float(self._latest_cmd_vel_nav.angular.z):.2f} rad/s\n"
            f"safe_wz={float(self._latest_cmd_vel_safe.angular.z):.2f} rad/s\n"
            f"odom_wz={float(self._latest_odom_raw.twist.twist.angular.z):.2f} rad/s"
        )
        marker_array.markers.append(text_marker)

        self._debug_markers_pub.publish(marker_array)

    def _publish_debug_delete_all(self) -> None:
        marker = Marker()
        marker.action = Marker.DELETEALL
        marker_array = MarkerArray()
        marker_array.markers.append(marker)
        self._debug_markers_pub.publish(marker_array)

    def _on_path_monitor_timer(self) -> None:
        if not self._active_goal_running():
            self._publish_debug_delete_all()
            return
        if self._replan_pending or self._active_path is None or self._active_goal_pose is None:
            return
        if self._latest_pose is None:
            return

        now_ns = self.get_clock().now().nanoseconds
        if now_ns < self._next_replan_allowed_ns:
            return
        if (
            float(now_ns - self._active_goal_sent_ns) / 1_000_000_000.0
            < self._path_replan_min_goal_age_s
        ):
            return

        current_pose = self._transform_pose(self._latest_pose)
        if current_pose is None:
            return

        closest_pose = closest_path_pose(self._active_path, current_pose.pose)
        if closest_pose is None:
            return

        goal_distance_m = distance_xy(current_pose.pose, self._active_goal_pose.pose)
        if goal_distance_m <= self._path_replan_min_goal_distance_m:
            self._publish_debug_delete_all()
            return

        distance_to_path_m = distance_xy(
            closest_pose.pose,
            current_pose.pose,
        )
        robot_yaw_rad = yaw_from_quaternion(current_pose.pose.orientation)
        path_yaw_rad = yaw_from_quaternion(closest_pose.pose.orientation)
        heading_error_rad = normalize_angle(path_yaw_rad - robot_yaw_rad)
        self._publish_debug_markers(
            current_pose=current_pose,
            closest_pose=closest_pose,
            distance_to_path_m=distance_to_path_m,
            heading_error_rad=heading_error_rad,
        )

        now_ns = self.get_clock().now().nanoseconds
        if (
            now_ns - self._last_debug_log_ns
            >= int(self._debug_log_period_s * 1_000_000_000.0)
        ):
            self._last_debug_log_ns = now_ns
            self.get_logger().info(
                "Path debug "
                f"(d={distance_to_path_m:.2f} m, "
                f"yaw_err={math.degrees(heading_error_rad):.1f} deg, "
                f"nav_wz={float(self._latest_cmd_vel_nav.angular.z):.2f} rad/s, "
                f"safe_wz={float(self._latest_cmd_vel_safe.angular.z):.2f} rad/s, "
                f"odom_wz={float(self._latest_odom_raw.twist.twist.angular.z):.2f} rad/s)"
            )
        if distance_to_path_m <= self._path_replan_distance_m:
            return

        self._replan_pending = True
        self._ignore_next_canceled_result = True
        self._next_replan_allowed_ns = now_ns + int(
            self._path_replan_cooldown_s * 1_000_000_000.0
        )
        self.get_logger().warning(
            "Robot se alejo del path activo "
            f"({distance_to_path_m:.2f} m). Replanificando hacia el mismo goal."
        )
        cancel_future = self._latest_goal_handle.cancel_goal_async()
        cancel_future.add_done_callback(self._on_cancel_for_replan)

    def _on_cancel_for_replan(self, future) -> None:
        try:
            cancel_response = future.result()
        except Exception as exc:  # pragma: no cover
            self._replan_pending = False
            self.get_logger().warning(f"Error cancelando FollowPath para replanificar: {exc}")
            return

        if cancel_response is None or not cancel_response.goals_canceling:
            self._replan_pending = False
            self.get_logger().warning(
                "No pude cancelar el FollowPath activo para replanificar"
            )
            return

        if self._latest_pose is None or self._active_goal_pose is None:
            self._replan_pending = False
            return

        current_pose = self._transform_pose(self._latest_pose)
        if current_pose is None:
            self._replan_pending = False
            return

        self._send_follow_path_goal(
            current_pose=current_pose,
            goal_pose=self._active_goal_pose,
            log_reason="replanificado",
        )

    def _on_goal_response(self, future) -> None:
        goal_handle = future.result()
        if goal_handle is None or not goal_handle.accepted:
            self.get_logger().warning("FollowPath rechazo el goal generado desde RViz")
            return

        self._latest_goal_handle = goal_handle
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._on_goal_result)

    def _on_goal_result(self, future) -> None:
        try:
            result = future.result()
        except Exception as exc:  # pragma: no cover
            self.get_logger().warning(f"Error esperando resultado de FollowPath: {exc}")
            return
        if (
            self._ignore_next_canceled_result
            and result.status == GoalStatus.STATUS_CANCELED
        ):
            self._ignore_next_canceled_result = False
            self.get_logger().info("FollowPath cancelado para replanificar")
            return
        self._latest_goal_handle = None
        self._active_path = None
        self._active_goal_pose = None
        self._publish_debug_delete_all()
        self._stop_hold_pub.publish(Empty())
        self.get_logger().info(f"Resultado FollowPath desde RViz: status={result.status}")


def main(args=None) -> None:
    rclpy.init(args=args)
    node = GoalPoseToFollowPathV2()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()

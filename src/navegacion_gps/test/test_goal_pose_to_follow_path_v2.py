import math

from geometry_msgs.msg import Pose

from navegacion_gps.goal_pose_to_follow_path_v2 import build_ackermann_path
from navegacion_gps.goal_pose_to_follow_path_v2 import minimum_distance_to_path_xy
from navegacion_gps.goal_pose_to_follow_path_v2 import quaternion_from_yaw
from navegacion_gps.goal_pose_to_follow_path_v2 import yaw_from_quaternion


def test_yaw_quaternion_roundtrip() -> None:
    yaw_rad = 0.73
    assert math.isclose(
        yaw_from_quaternion(quaternion_from_yaw(yaw_rad)),
        yaw_rad,
        rel_tol=0.0,
        abs_tol=1.0e-9,
    )


def test_build_ackermann_path_includes_start_and_goal() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 2.0
    goal_pose.position.y = 0.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
    )

    assert path.header.frame_id == "odom"
    assert len(path.poses) >= 4
    assert math.isclose(path.poses[0].pose.position.x, 0.0)
    assert math.isclose(path.poses[-1].pose.position.x, 2.0)


def test_build_ackermann_path_uses_goal_orientation_at_end() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 0.2
    goal_pose.position.y = 0.1
    goal_pose.orientation = quaternion_from_yaw(1.2)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=1.0,
        min_intermediate_poses=0,
    )

    assert math.isclose(
        yaw_from_quaternion(path.poses[-1].pose.orientation),
        1.2,
        rel_tol=0.0,
        abs_tol=1.0e-9,
    )


def test_build_ackermann_path_respects_start_heading() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.3)
    goal_pose = Pose()
    goal_pose.position.x = 1.0
    goal_pose.position.y = 1.0
    goal_pose.orientation = quaternion_from_yaw(0.8)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.2,
        min_intermediate_poses=2,
    )

    assert math.isclose(
        yaw_from_quaternion(path.poses[0].pose.orientation),
        0.3,
        rel_tol=0.0,
        abs_tol=1.0e-6,
    )


def test_build_ackermann_path_is_nearly_straight_for_aligned_goal() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 5.0
    goal_pose.position.y = 0.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
        use_goal_orientation=False,
    )

    assert len(path.poses) >= 4
    for pose_stamped in path.poses:
        assert math.isclose(
            float(pose_stamped.pose.position.y),
            0.0,
            rel_tol=0.0,
            abs_tol=1.0e-9,
        )
        assert math.isclose(
            yaw_from_quaternion(pose_stamped.pose.orientation),
            0.0,
            rel_tol=0.0,
            abs_tol=1.0e-9,
        )


def test_build_ackermann_path_curves_less_for_mild_heading_error() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.25)
    goal_pose = Pose()
    goal_pose.position.x = 6.0
    goal_pose.position.y = 0.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
        use_goal_orientation=False,
    )

    max_abs_y = max(abs(float(p.pose.position.y)) for p in path.poses)
    assert max_abs_y < 0.75


def test_build_ackermann_path_uses_arc_then_line_for_lateral_goal() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 6.0
    goal_pose.position.y = 2.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
        use_goal_orientation=False,
        turning_radius_m=2.4,
    )

    assert len(path.poses) >= 4
    first_half = path.poses[: len(path.poses) // 2]
    max_abs_y = max(abs(float(p.pose.position.y)) for p in first_half)
    assert max_abs_y > 0.2
    assert math.isclose(
        float(path.poses[-1].pose.position.x),
        6.0,
        rel_tol=0.0,
        abs_tol=1.0e-6,
    )
    assert math.isclose(
        float(path.poses[-1].pose.position.y),
        2.0,
        rel_tol=0.0,
        abs_tol=1.0e-6,
    )


def test_minimum_distance_to_path_xy_is_zero_on_path() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 2.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
    )

    probe_pose = Pose()
    probe_pose.position.x = float(path.poses[1].pose.position.x)
    probe_pose.position.y = float(path.poses[1].pose.position.y)

    assert math.isclose(
        minimum_distance_to_path_xy(path, probe_pose),
        0.0,
        rel_tol=0.0,
        abs_tol=1.0e-9,
    )


def test_minimum_distance_to_path_xy_detects_lateral_offset() -> None:
    start_pose = Pose()
    start_pose.orientation = quaternion_from_yaw(0.0)
    goal_pose = Pose()
    goal_pose.position.x = 4.0
    goal_pose.orientation = quaternion_from_yaw(0.0)

    path = build_ackermann_path(
        start_pose=start_pose,
        goal_pose=goal_pose,
        frame_id="odom",
        step_distance_m=0.5,
        min_intermediate_poses=2,
    )

    probe_pose = Pose()
    probe_pose.position.x = 2.0
    probe_pose.position.y = 1.0

    assert minimum_distance_to_path_xy(path, probe_pose) > 0.9

import math

from navegacion_gps.cmd_vel_ackermann_bridge_v2 import (
    translate_desired_command_to_gazebo_twist,
)


def test_translate_desired_command_to_gazebo_twist_uses_steering_angle() -> None:
    linear_x, steering_angle_rad = translate_desired_command_to_gazebo_twist(
        speed_mps=0.6,
        steer_pct=50,
        sim_max_forward_mps=4.0,
        sim_max_reverse_mps=1.3,
        sim_max_steering_angle_rad=0.5235987756,
    )

    assert math.isclose(linear_x, 0.6, rel_tol=0.0, abs_tol=1.0e-9)
    assert math.isclose(
        steering_angle_rad,
        0.2617993878,
        rel_tol=0.0,
        abs_tol=1.0e-9,
    )


def test_translate_desired_command_to_gazebo_twist_clamps_reverse_speed() -> None:
    linear_x, steering_angle_rad = translate_desired_command_to_gazebo_twist(
        speed_mps=-2.0,
        steer_pct=-100,
        sim_max_forward_mps=4.0,
        sim_max_reverse_mps=1.3,
        sim_max_steering_angle_rad=0.5235987756,
    )

    assert math.isclose(linear_x, -1.3, rel_tol=0.0, abs_tol=1.0e-9)
    assert math.isclose(
        steering_angle_rad,
        -0.5235987756,
        rel_tol=0.0,
        abs_tol=1.0e-9,
    )

#!/usr/bin/env python3
"""Deterministic continuous /cmd_vel_ws step publisher (single process)."""

from __future__ import annotations

import argparse
import csv
import time
from dataclasses import dataclass
from pathlib import Path

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node


@dataclass(frozen=True)
class Step:
    label: str
    linear_x_mps: float
    target_kmh: float
    duration_s: float


DEFAULT_STEPS = (
    Step("stop_init", 0.0, 0.0, 3.0),
    Step("step_2kmh", 0.556, 2.0, 8.0),
    Step("step_4kmh", 1.111, 4.0, 8.0),
    Step("step_1kmh", 0.278, 1.0, 8.0),
    Step("stop_final", 0.0, 0.0, 5.0),
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Publish closed-loop cmd_vel steps continuously without gaps."
    )
    parser.add_argument("--topic", default="/cmd_vel_ws")
    parser.add_argument("--rate", type=float, default=20.0)
    parser.add_argument("--transitions-csv", default="/tmp/closed_loop_events.csv")
    return parser


def _write_event(writer: csv.writer, step: Step, start_epoch: float) -> None:
    writer.writerow(
        [
            step.label,
            f"{start_epoch:.9f}",
            f"{step.target_kmh:.3f}",
            f"{step.duration_s:.3f}s",
        ]
    )


def main() -> int:
    args = _build_parser().parse_args()
    if args.rate <= 0.0:
        raise SystemExit("--rate must be > 0")

    event_fp = None
    event_writer = None
    if args.transitions_csv:
        event_path = Path(args.transitions_csv)
        event_path.parent.mkdir(parents=True, exist_ok=True)
        event_fp = event_path.open("w", encoding="utf-8", newline="")
        event_writer = csv.writer(event_fp)
        event_writer.writerow(["label", "start_epoch", "target_kmh", "duration_s"])

    rclpy.init()
    node = Node("closed_loop_step_publisher")
    pub = node.create_publisher(Twist, args.topic, 20)

    try:
        period = 1.0 / args.rate
        msg = Twist()
        msg.angular.z = 0.0

        for step in DEFAULT_STEPS:
            stage_start_epoch = time.time()
            stage_end_mono = time.monotonic() + step.duration_s
            if event_writer is not None:
                _write_event(event_writer, step, stage_start_epoch)
                event_fp.flush()

            print(
                f"[STEP] {step.label} x={step.linear_x_mps:.3f} "
                f"target={step.target_kmh:.2f}km/h dur={step.duration_s:.1f}s",
                flush=True,
            )

            next_tick = time.monotonic()
            while True:
                now = time.monotonic()
                if now >= stage_end_mono:
                    break

                msg.linear.x = float(step.linear_x_mps)
                pub.publish(msg)
                rclpy.spin_once(node, timeout_sec=0.0)

                next_tick += period
                sleep_s = next_tick - time.monotonic()
                if sleep_s > 0.0:
                    time.sleep(sleep_s)
                elif sleep_s < -period:
                    next_tick = time.monotonic()

        # Ensure a final stop frame is emitted after the schedule.
        msg.linear.x = 0.0
        for _ in range(5):
            pub.publish(msg)
            rclpy.spin_once(node, timeout_sec=0.0)
            time.sleep(period)
    finally:
        node.destroy_node()
        rclpy.shutdown()
        if event_fp is not None:
            event_fp.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

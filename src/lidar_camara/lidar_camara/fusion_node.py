#!/usr/bin/env python3
"""
fusion_node.py — Combina detecciones YOLO con profundidad LiDAR.

Arquitectura (siguiendo el documento de referencia):
  - Dos MutuallyExclusiveCallbackGroup separados: LiDAR y cámara no se bloquean
  - Patrón latest-frame-only: sin ApproximateTimeSynchronizer ni colas
  - Worker thread desacoplado del loop de ROS 2 (no bloquea control ni nav)
  - QoS depth=1 BEST_EFFORT: frescura sobre completitud

Outputs:
  /fusion/targets            String (JSON): objetos con distancia LiDAR 3D
  /fusion/brake_active       Bool: True si objeto detectado dentro de brake_distance_m
  /fusion/closest_obstacle_m Float64: distancia al objeto confirmado más cercano
  /fusion/telemetry          String (JSON): estadísticas internas

Lógica de asociación azimut:
  La detección YOLO da el centro en píxeles (cx_px). Se convierte a ángulo azimut
  usando el FOV horizontal de la cámara. El LiDAR da puntos 3D en frame robot
  (x=adelante, y=izquierda). Se buscan los puntos dentro del sector azimut ±
  azimuth_tolerance_deg. La distancia mínima en ese sector es la profundidad LiDAR
  asociada al objeto detectado por la cámara.

  Si la cámara y el LiDAR comparten eje x (adelante) pero la cámara tiene x
  creciendo hacia la derecha y el LiDAR usa la convención ROS (+y izquierda),
  el mapeo es: cx_norm > 0.5 → derecha cámara → -y robot → lidar_az < 0.
  El parámetro azimuth_flip invierte este mapeo si el montaje es distinto.
"""
from __future__ import annotations

import json
import math
import threading
import time
from typing import Optional

import numpy as np
import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import Bool, Float64, String
from vision_msgs.msg import Detection2DArray


class FusionNode(Node):
    def __init__(self) -> None:
        super().__init__('lidar_camara_fusion')

        # ── parameters ──────────────────────────────────────────────────
        self.declare_parameter('lidar_topic', '/scan_3d')
        self.declare_parameter('detections_topic', '/detections')
        self.declare_parameter('camera_hfov_deg', 90.0)
        self.declare_parameter('image_width', 640)
        self.declare_parameter('image_height', 360)
        self.declare_parameter('brake_distance_m', 2.0)
        self.declare_parameter('warn_distance_m', 4.0)
        self.declare_parameter('lidar_min_range_m', 0.3)
        self.declare_parameter('lidar_max_range_m', 15.0)
        self.declare_parameter('azimuth_tolerance_deg', 8.0)
        self.declare_parameter('worker_hz', 10.0)
        # Set True si el eje Y del LiDAR apunta a la derecha (no estándar ROS)
        self.declare_parameter('azimuth_flip', False)

        lidar_topic      = str(self.get_parameter('lidar_topic').value)
        detections_topic = str(self.get_parameter('detections_topic').value)
        self._hfov       = float(self.get_parameter('camera_hfov_deg').value)
        self._img_w      = int(self.get_parameter('image_width').value)
        self._img_h      = int(self.get_parameter('image_height').value)
        self._brake_dist = float(self.get_parameter('brake_distance_m').value)
        self._warn_dist  = float(self.get_parameter('warn_distance_m').value)
        self._lidar_min  = float(self.get_parameter('lidar_min_range_m').value)
        self._lidar_max  = float(self.get_parameter('lidar_max_range_m').value)
        self._az_tol     = math.radians(float(self.get_parameter('azimuth_tolerance_deg').value))
        self._worker_hz  = float(self.get_parameter('worker_hz').value)
        self._az_flip    = bool(self.get_parameter('azimuth_flip').value)

        # ── callback groups (separados para que LiDAR y cámara no compitan) ──
        self._det_cbg   = MutuallyExclusiveCallbackGroup()
        self._cloud_cbg = MutuallyExclusiveCallbackGroup()

        # ── QoS sensor: depth=1, BEST_EFFORT — frescura sobre completitud ──
        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        # ── latest-frame storage (patrón latest-only, sin cola) ──────────
        self._latest_detections: Optional[Detection2DArray] = None
        self._latest_cloud: Optional[PointCloud2] = None
        self._det_lock   = threading.Lock()
        self._cloud_lock = threading.Lock()

        # ── subscriptions ────────────────────────────────────────────────
        self._det_sub = self.create_subscription(
            Detection2DArray, detections_topic, self._on_detections,
            sensor_qos, callback_group=self._det_cbg,
        )
        self._cloud_sub = self.create_subscription(
            PointCloud2, lidar_topic, self._on_cloud,
            sensor_qos, callback_group=self._cloud_cbg,
        )

        # ── publishers ───────────────────────────────────────────────────
        self._targets_pub   = self.create_publisher(String,  '/fusion/targets',            10)
        self._brake_pub     = self.create_publisher(Bool,    '/fusion/brake_active',        10)
        self._closest_pub   = self.create_publisher(Float64, '/fusion/closest_obstacle_m',  10)
        self._telemetry_pub = self.create_publisher(String,  '/fusion/telemetry',           10)

        # ── stats ────────────────────────────────────────────────────────
        self._stats = {
            'fusions': 0,
            'det_frames': 0,
            'cloud_frames': 0,
            'brake_events': 0,
        }

        # ── worker thread (desacoplado del executor de ROS 2) ─────────────
        self._stop_event = threading.Event()
        self._worker = threading.Thread(
            target=self._worker_loop, name='fusion-worker', daemon=True
        )
        self._worker.start()

        self.get_logger().info(
            f'lidar_camara_fusion listo '
            f'(lidar={lidar_topic}, detecciones={detections_topic}, '
            f'hfov={self._hfov}°, brake<{self._brake_dist}m, warn<{self._warn_dist}m)'
        )

    # ── callbacks: solo almacenan el frame más reciente ──────────────────

    def _on_detections(self, msg: Detection2DArray) -> None:
        with self._det_lock:
            self._latest_detections = msg
        self._stats['det_frames'] += 1

    def _on_cloud(self, msg: PointCloud2) -> None:
        with self._cloud_lock:
            self._latest_cloud = msg
        self._stats['cloud_frames'] += 1

    # ── worker: fusión y publicación ──────────────────────────────────────

    def _worker_loop(self) -> None:
        period = 1.0 / self._worker_hz
        while not self._stop_event.is_set():
            t0 = time.monotonic()
            try:
                self._fuse_and_publish()
            except Exception as exc:  # noqa: BLE001
                self.get_logger().warning(f'fusion worker error: {exc}')
            elapsed = time.monotonic() - t0
            wait = period - elapsed
            if wait > 0:
                self._stop_event.wait(wait)

    def _fuse_and_publish(self) -> None:
        with self._det_lock:
            detections = self._latest_detections
        with self._cloud_lock:
            cloud = self._latest_cloud

        if detections is None:
            return

        points = self._parse_cloud(cloud) if cloud is not None else None

        targets = []
        for det in detections.detections:
            if not det.results:
                continue
            hyp = det.results[0].hypothesis
            label = str(hyp.class_id)
            score = float(hyp.score)

            cx_px    = float(det.bbox.center.position.x)
            cy_px    = float(det.bbox.center.position.y)
            cx_norm  = cx_px / max(self._img_w, 1)

            # Ángulo azimut desde el centro de la cámara
            # cx_norm=0.5 → 0°, cx_norm=0 → -hfov/2, cx_norm=1 → +hfov/2
            cam_az_deg = (cx_norm - 0.5) * self._hfov
            if self._az_flip:
                cam_az_deg = -cam_az_deg

            distance_m = -1.0
            x3 = y3 = z3 = None

            if points is not None and len(points) > 0:
                cam_az_rad = math.radians(cam_az_deg)
                # Convención ROS: +x adelante, +y izquierda
                # Cámara derecha (cx_norm > 0.5) → robot -y → azimut negativo
                lidar_az = -cam_az_rad

                pt_az    = np.arctan2(points[:, 1], points[:, 0])
                az_diff  = np.abs(pt_az - lidar_az)
                az_diff  = np.where(az_diff > math.pi, 2 * math.pi - az_diff, az_diff)
                ranges   = np.linalg.norm(points[:, :3], axis=1)

                mask = (
                    (az_diff < self._az_tol)
                    & (points[:, 0] > 0)           # solo hacia adelante
                    & (ranges > self._lidar_min)
                    & (ranges < self._lidar_max)
                )
                sector_pts = points[mask]
                if len(sector_pts) > 0:
                    sector_r = ranges[mask]
                    idx       = int(np.argmin(sector_r))
                    distance_m = float(sector_r[idx])
                    x3 = float(sector_pts[idx, 0])
                    y3 = float(sector_pts[idx, 1])
                    z3 = float(sector_pts[idx, 2])

            targets.append({
                'label':       label,
                'score':       round(score, 3),
                'cx_px':       round(cx_px, 1),
                'cy_px':       round(cy_px, 1),
                'azimuth_deg': round(cam_az_deg, 2),
                'distance_m':  round(distance_m, 3),
                'x_m':         round(x3, 3) if x3 is not None else None,
                'y_m':         round(y3, 3) if y3 is not None else None,
                'z_m':         round(z3, 3) if z3 is not None else None,
            })

        confirmed = [t for t in targets if t['distance_m'] > 0]
        closest_m = min((t['distance_m'] for t in confirmed), default=-1.0)
        brake_active = closest_m > 0 and closest_m < self._brake_dist
        warn_active  = closest_m > 0 and closest_m < self._warn_dist

        self._stats['fusions'] += 1
        if brake_active:
            self._stats['brake_events'] += 1

        self._targets_pub.publish(String(data=json.dumps(targets)))

        brake_msg = Bool()
        brake_msg.data = brake_active
        self._brake_pub.publish(brake_msg)

        closest_msg = Float64()
        closest_msg.data = closest_m
        self._closest_pub.publish(closest_msg)

        telem = {
            **self._stats,
            'n_detections': len(targets),
            'n_confirmed':  len(confirmed),
            'closest_m':    round(closest_m, 3),
            'brake_active': brake_active,
            'warn_active':  warn_active,
            'lidar_ok':     cloud is not None,
        }
        self._telemetry_pub.publish(String(data=json.dumps(telem)))

    @staticmethod
    def _parse_cloud(msg: PointCloud2) -> Optional[np.ndarray]:
        """PointCloud2 → Nx3 float32 (x, y, z). Retorna None si falla."""
        field_map = {f.name: f.offset for f in msg.fields}
        if not all(k in field_map for k in ('x', 'y', 'z')):
            return None
        n = msg.width * msg.height
        if n == 0:
            return None
        ps  = msg.point_step
        raw = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(n, ps)
        x_o, y_o, z_o = field_map['x'], field_map['y'], field_map['z']
        # Cada columna de 4 bytes → float32 (little-endian estándar)
        x = raw[:, x_o:x_o + 4].copy().view(np.float32).reshape(-1)
        y = raw[:, y_o:y_o + 4].copy().view(np.float32).reshape(-1)
        z = raw[:, z_o:z_o + 4].copy().view(np.float32).reshape(-1)
        pts   = np.stack([x, y, z], axis=1)
        valid = np.isfinite(pts).all(axis=1)
        return pts[valid]

    def destroy_node(self) -> bool:
        self._stop_event.set()
        self._worker.join(timeout=2.0)
        return super().destroy_node()


def main(args=None) -> None:
    rclpy.init(args=args)
    node = FusionNode()
    executor = MultiThreadedExecutor(num_threads=3)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

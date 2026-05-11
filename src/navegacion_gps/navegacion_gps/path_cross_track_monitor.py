"""
path_cross_track_monitor  — NODO TEMPORAL DE DIAGNÓSTICO

Mide en tiempo real la distancia perpendicular entre el robot y la trayectoria
planeada por Nav2 (la "línea verde" en RViz).

  cross-track error = mínima distancia del robot a cualquier segmento del path

Fuentes:
  /plan              (nav_msgs/Path)     — path actual del planner
  /odometry/global   (nav_msgs/Odometry) — pose del robot en frame map

Salidas:
  /nav_diagnostics/cross_track_error_m  (std_msgs/Float64)
  Log WARN cada vez que supera warn_threshold_m (default 0.4 m)

Cómo usarlo (sin modificar ningún launch):

    ros2 run navegacion_gps path_cross_track_monitor

    # Para ver el valor en tiempo real:
    ros2 topic echo /nav_diagnostics/cross_track_error_m

    # Para graficar (requiere rqt_plot):
    ros2 run rqt_plot rqt_plot /nav_diagnostics/cross_track_error_m/data

TEMPORAL: este nodo es sólo para diagnóstico.
Eliminarlo una vez entendida la causa de la oscilación.
"""
from __future__ import annotations

import math
from typing import Optional


# ===========================================================================
# Geometría pura — cero imports externos, completamente testeable
# ===========================================================================

def _dist_point_to_segment(
    px: float, py: float,
    ax: float, ay: float,
    bx: float, by: float,
) -> float:
    """
    Distancia mínima del punto P=(px,py) al segmento A-B.

    Si el pie perpendicular cae fuera del segmento, usa el extremo más cercano.
    """
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1.0e-12:
        # Segmento degenerado — distancia al punto A
        return math.hypot(px - ax, py - ay)
    # Proyección escalar t ∈ [0,1]
    t = ((px - ax) * dx + (py - ay) * dy) / len_sq
    t = max(0.0, min(1.0, t))
    foot_x = ax + t * dx
    foot_y = ay + t * dy
    return math.hypot(px - foot_x, py - foot_y)


def cross_track_error(
    robot_x: float,
    robot_y: float,
    path_xy: list[tuple[float, float]],
) -> Optional[float]:
    """
    Distancia mínima del robot a la polilínea del path.

    Parameters
    ----------
    robot_x, robot_y : float
        Posición del robot en el mismo frame que path_xy.
    path_xy : list of (x, y)
        Lista de vértices del path. Al menos 1 punto.

    Returns
    -------
    float o None
        Distancia en metros, o None si el path está vacío.
    """
    n = len(path_xy)
    if n == 0:
        return None
    if n == 1:
        return math.hypot(robot_x - path_xy[0][0], robot_y - path_xy[0][1])

    min_dist = math.inf
    for i in range(n - 1):
        d = _dist_point_to_segment(
            robot_x, robot_y,
            path_xy[i][0], path_xy[i][1],
            path_xy[i + 1][0], path_xy[i + 1][1],
        )
        if d < min_dist:
            min_dist = d
    return min_dist


def extract_path_xy(path_msg) -> list[tuple[float, float]]:
    """
    Extrae lista de (x, y) de un nav_msgs/Path.
    Duck-typed: funciona con el tipo ROS real o con stubs de test.
    """
    return [
        (float(pose.pose.position.x), float(pose.pose.position.y))
        for pose in path_msg.poses
    ]


# ===========================================================================
# Nodo ROS 2
# ===========================================================================

def _build_node():
    import rclpy
    from nav_msgs.msg import Odometry, Path
    from rclpy.node import Node
    from std_msgs.msg import Float64

    class PathCrossTrackMonitor(Node):
        """TEMPORAL — mide cross-track error robot↔path."""

        def __init__(self) -> None:
            super().__init__("path_cross_track_monitor")

            self.declare_parameter("plan_topic", "/plan")
            self.declare_parameter("odom_topic", "/odometry/global")
            self.declare_parameter("output_topic", "/nav_diagnostics/cross_track_error_m")
            self.declare_parameter("warn_threshold_m", 0.4)
            self.declare_parameter("pub_hz", 10.0)

            plan_topic  = str(self.get_parameter("plan_topic").value)
            odom_topic  = str(self.get_parameter("odom_topic").value)
            out_topic   = str(self.get_parameter("output_topic").value)
            self._warn  = float(self.get_parameter("warn_threshold_m").value)
            pub_hz      = max(1.0, float(self.get_parameter("pub_hz").value))

            self._path_xy: list[tuple[float, float]] = []
            self._robot_x: Optional[float] = None
            self._robot_y: Optional[float] = None

            self._pub = self.create_publisher(Float64, out_topic, 10)
            self.create_subscription(Path, plan_topic, self._on_plan, 10)
            self.create_subscription(Odometry, odom_topic, self._on_odom, 10)
            self.create_timer(1.0 / pub_hz, self._publish)

            self.get_logger().info(
                "⚠  path_cross_track_monitor ACTIVO (nodo temporal de diagnóstico)\n"
                f"   plan={plan_topic}  odom={odom_topic}  out={out_topic}\n"
                f"   warn_threshold={self._warn:.2f} m"
            )

        def _on_plan(self, msg: Path) -> None:
            self._path_xy = extract_path_xy(msg)

        def _on_odom(self, msg: Odometry) -> None:
            self._robot_x = float(msg.pose.pose.position.x)
            self._robot_y = float(msg.pose.pose.position.y)

        def _publish(self) -> None:
            if self._robot_x is None or not self._path_xy:
                return
            err = cross_track_error(self._robot_x, self._robot_y, self._path_xy)
            if err is None:
                return

            msg = Float64()
            msg.data = err
            self._pub.publish(msg)

            if err > self._warn:
                self.get_logger().warn(
                    f"cross_track_error = {err:.3f} m  "
                    f"(robot=({self._robot_x:.2f},{self._robot_y:.2f})  "
                    f"path_pts={len(self._path_xy)})"
                )

    return PathCrossTrackMonitor()


def main(args=None) -> None:
    import rclpy
    rclpy.init(args=args)
    node = _build_node()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()

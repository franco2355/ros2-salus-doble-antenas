#!/usr/bin/env python3

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np
import rclpy
from ament_index_python.packages import get_package_share_directory
from cv_bridge import CvBridge
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import Image
from std_msgs.msg import Header, String
from vision_msgs.msg import Detection2D, Detection2DArray, ObjectHypothesisWithPose

try:
    import onnxruntime as ort
except ImportError as exc:  # pragma: no cover - handled at runtime on target robot
    ort = None
    _ORT_IMPORT_ERROR = exc
else:
    _ORT_IMPORT_ERROR = None


@dataclass
class DetectionResult:
    class_id: int
    label: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def center_x(self) -> float:
        return self.x1 + self.width * 0.5

    @property
    def center_y(self) -> float:
        return self.y1 + self.height * 0.5


def _resolve_default_labels_path() -> str:
    candidates: List[Path] = []
    try:
        share_dir = Path(get_package_share_directory('vision_pipeline'))
        candidates.append(share_dir / 'config' / 'coco_80.names')
    except Exception:
        pass

    candidates.append(Path(__file__).resolve().parents[1] / 'config' / 'coco_80.names')

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return ''


def _load_labels(path: str) -> List[str]:
    if not path:
        return []

    labels_path = Path(path).expanduser()
    if not labels_path.exists():
        raise FileNotFoundError(f'class_names_path not found: {labels_path}')

    labels = []
    for raw_line in labels_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if line and not line.startswith('#'):
            labels.append(line)
    return labels


def _flatten_indices(indices: object) -> List[int]:
    if indices is None:
        return []
    if isinstance(indices, np.ndarray):
        return [int(x) for x in indices.flatten().tolist()]
    if isinstance(indices, (list, tuple)):
        flattened: List[int] = []
        for item in indices:
            if isinstance(item, (list, tuple, np.ndarray)):
                flattened.extend(_flatten_indices(item))
            else:
                flattened.append(int(item))
        return flattened
    return [int(indices)]


def _maybe_static_dim(value: object) -> Optional[int]:
    return value if isinstance(value, int) and value > 0 else None


class YoloOnnxDetectorNode(Node):
    def __init__(self) -> None:
        super().__init__('yolo_onnx_detector')

        if ort is None:
            raise RuntimeError(
                'onnxruntime is not available. Install python3-onnxruntime or '
                '`pip install onnxruntime` before running this node.'
            ) from _ORT_IMPORT_ERROR

        self.declare_parameter('image_topic', '/camera/image_raw')
        self.declare_parameter('detections_topic', '/detections')
        self.declare_parameter('debug_topic', '/objeto_detectado')
        self.declare_parameter('model_path', '')
        self.declare_parameter('class_names_path', _resolve_default_labels_path())
        self.declare_parameter('input_width', 640)
        self.declare_parameter('input_height', 640)
        self.declare_parameter('conf_threshold', 0.40)
        self.declare_parameter('nms_iou_threshold', 0.45)
        self.declare_parameter('max_detections', 20)
        self.declare_parameter('max_fps', 15.0)
        self.declare_parameter('execution_provider', 'auto')
        self.declare_parameter('intra_op_threads', 2)
        self.declare_parameter('inter_op_threads', 1)
        self.declare_parameter('warmup_runs', 1)
        self.declare_parameter('log_interval_sec', 5.0)
        self.declare_parameter('publish_empty_debug', True)

        self._image_topic = str(self.get_parameter('image_topic').value)
        detections_topic = str(self.get_parameter('detections_topic').value)
        debug_topic = str(self.get_parameter('debug_topic').value)
        model_path_raw = str(self.get_parameter('model_path').value)
        class_names_path = str(self.get_parameter('class_names_path').value)
        if not class_names_path:
            class_names_path = _resolve_default_labels_path()
        self._input_width = max(32, int(self.get_parameter('input_width').value))
        self._input_height = max(32, int(self.get_parameter('input_height').value))
        self._conf_threshold = float(self.get_parameter('conf_threshold').value)
        self._nms_iou_threshold = float(self.get_parameter('nms_iou_threshold').value)
        self._max_detections = max(1, int(self.get_parameter('max_detections').value))
        self._max_fps = max(0.0, float(self.get_parameter('max_fps').value))
        self._execution_provider = str(self.get_parameter('execution_provider').value).lower()
        self._intra_op_threads = max(1, int(self.get_parameter('intra_op_threads').value))
        self._inter_op_threads = max(1, int(self.get_parameter('inter_op_threads').value))
        self._warmup_runs = max(0, int(self.get_parameter('warmup_runs').value))
        self._log_interval_sec = max(0.5, float(self.get_parameter('log_interval_sec').value))
        self._publish_empty_debug = bool(self.get_parameter('publish_empty_debug').value)

        self._model_path = Path(model_path_raw).expanduser() if model_path_raw else None
        if self._model_path is None or not self._model_path.exists():
            raise FileNotFoundError(
                'model_path must point to a YOLO ONNX file, for example '
                '/home/user/models/yolov8n.onnx'
            )

        self._labels = _load_labels(class_names_path)
        self._bridge = CvBridge()

        detection_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=5,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE,
        )
        debug_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=5,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        self._detections_pub = self.create_publisher(Detection2DArray, detections_topic, detection_qos)
        self._debug_pub = self.create_publisher(String, debug_topic, debug_qos)
        self._image_sub = self.create_subscription(
            Image,
            self._image_topic,
            self._image_callback,
            qos_profile_sensor_data,
        )

        self._frame_lock = threading.Lock()
        self._frame_event = threading.Event()
        self._stop_event = threading.Event()
        self._latest_msg: Optional[Image] = None
        self._latest_seq = 0
        self._processed_seq = -1

        self._session, self._providers = self._create_session()
        self._input_name = self._session.get_inputs()[0].name
        self._output_names = [output.name for output in self._session.get_outputs()]
        self._input_dtype = np.float16 if 'float16' in self._session.get_inputs()[0].type else np.float32
        self._reconcile_input_size_with_model()
        self._warmup_model()

        self._processed_frames = 0
        self._dropped_frames = 0
        self._ema_inference_ms = 0.0
        self._last_log_monotonic = time.monotonic()

        self._worker = threading.Thread(target=self._worker_loop, name='vision-inference', daemon=True)
        self._worker.start()

        self.get_logger().info(
            'yolo_onnx_detector ready '
            f'(image_topic={self._image_topic}, model={self._model_path}, '
            f'input={self._input_width}x{self._input_height}, '
            f'providers={self._providers})'
        )

    def _create_session(self) -> Tuple[ort.InferenceSession, List[str]]:
        providers = self._select_providers(self._execution_provider)

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.intra_op_num_threads = self._intra_op_threads
        options.inter_op_num_threads = self._inter_op_threads
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_cpu_mem_arena = True

        session = ort.InferenceSession(
            str(self._model_path),
            sess_options=options,
            providers=providers,
        )
        return session, session.get_providers()

    def _select_providers(self, selection: str) -> List[str]:
        available = ort.get_available_providers()
        provider_map = {
            'auto': [
                'TensorrtExecutionProvider',
                'CUDAExecutionProvider',
                'OpenVINOExecutionProvider',
                'CPUExecutionProvider',
            ],
            'tensorrt': ['TensorrtExecutionProvider', 'CUDAExecutionProvider', 'CPUExecutionProvider'],
            'cuda': ['CUDAExecutionProvider', 'CPUExecutionProvider'],
            'openvino': ['OpenVINOExecutionProvider', 'CPUExecutionProvider'],
            'cpu': ['CPUExecutionProvider'],
        }

        if selection not in provider_map:
            raise ValueError(
                'execution_provider must be one of: auto, tensorrt, cuda, openvino, cpu'
            )

        providers = [provider for provider in provider_map[selection] if provider in available]
        if not providers:
            raise RuntimeError(
                f'No compatible ONNX Runtime providers for selection={selection}. '
                f'Available providers: {available}'
            )
        return providers

    def _reconcile_input_size_with_model(self) -> None:
        input_shape = self._session.get_inputs()[0].shape
        if len(input_shape) < 4:
            return

        model_height = _maybe_static_dim(input_shape[2])
        model_width = _maybe_static_dim(input_shape[3])
        if model_width is None or model_height is None:
            return

        if model_width != self._input_width or model_height != self._input_height:
            self.get_logger().warning(
                'input_width/input_height do not match the static ONNX input. '
                f'Using model shape {model_width}x{model_height} instead.'
            )
            self._input_width = model_width
            self._input_height = model_height

    def _warmup_model(self) -> None:
        if self._warmup_runs <= 0:
            return

        dummy = np.zeros((1, 3, self._input_height, self._input_width), dtype=self._input_dtype)
        for _ in range(self._warmup_runs):
            self._session.run(self._output_names, {self._input_name: dummy})

    def _image_callback(self, msg: Image) -> None:
        with self._frame_lock:
            if self._latest_msg is not None and self._latest_seq != self._processed_seq:
                self._dropped_frames += 1
            self._latest_msg = msg
            self._latest_seq += 1
        self._frame_event.set()

    def _worker_loop(self) -> None:
        min_period = 0.0 if self._max_fps <= 0.0 else 1.0 / self._max_fps

        while not self._stop_event.is_set():
            self._frame_event.wait(timeout=0.05)
            if self._stop_event.is_set():
                break

            with self._frame_lock:
                if self._latest_msg is None or self._latest_seq == self._processed_seq:
                    self._frame_event.clear()
                    continue
                msg = self._latest_msg
                current_seq = self._latest_seq
                self._frame_event.clear()

            cycle_start = time.perf_counter()
            try:
                self._process_image(msg)
            except Exception as exc:
                self.get_logger().error(f'inference failed: {exc}')
            finally:
                with self._frame_lock:
                    self._processed_seq = current_seq

            elapsed = time.perf_counter() - cycle_start
            if min_period > elapsed:
                self._stop_event.wait(min_period - elapsed)

    def _process_image(self, msg: Image) -> None:
        frame_bgr = self._bridge.imgmsg_to_cv2(msg, desired_encoding='bgr8')
        original_h, original_w = frame_bgr.shape[:2]

        input_tensor, scale, pad = self._preprocess(frame_bgr)

        inference_start = time.perf_counter()
        outputs = self._session.run(self._output_names, {self._input_name: input_tensor})
        inference_ms = (time.perf_counter() - inference_start) * 1000.0

        detections = self._postprocess(outputs, original_w, original_h, scale, pad)
        if not rclpy.ok():
            return
        self._publish_detections(msg.header, detections)
        self._publish_debug_text(detections)

        self._processed_frames += 1
        if self._ema_inference_ms <= 0.0:
            self._ema_inference_ms = inference_ms
        else:
            self._ema_inference_ms = 0.9 * self._ema_inference_ms + 0.1 * inference_ms

        now = time.monotonic()
        if now - self._last_log_monotonic >= self._log_interval_sec:
            self._last_log_monotonic = now
            self.get_logger().info(
                'vision stats '
                f'(frames={self._processed_frames}, dropped={self._dropped_frames}, '
                f'inference_ms={self._ema_inference_ms:.1f}, detections={len(detections)})'
            )

    def _preprocess(self, image_bgr: np.ndarray) -> Tuple[np.ndarray, float, Tuple[int, int]]:
        src_h, src_w = image_bgr.shape[:2]
        scale = min(self._input_width / src_w, self._input_height / src_h)
        resized_w = max(1, int(round(src_w * scale)))
        resized_h = max(1, int(round(src_h * scale)))

        resized = cv2.resize(image_bgr, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self._input_height, self._input_width, 3), 114, dtype=np.uint8)

        pad_x = (self._input_width - resized_w) // 2
        pad_y = (self._input_height - resized_h) // 2
        canvas[pad_y:pad_y + resized_h, pad_x:pad_x + resized_w] = resized

        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        chw = np.transpose(rgb, (2, 0, 1))
        tensor = np.ascontiguousarray(chw, dtype=np.float32) / 255.0
        tensor = tensor.astype(self._input_dtype, copy=False)
        tensor = np.expand_dims(tensor, axis=0)
        return tensor, scale, (pad_x, pad_y)

    def _postprocess(
        self,
        outputs: Sequence[np.ndarray],
        original_w: int,
        original_h: int,
        scale: float,
        pad: Tuple[int, int],
    ) -> List[DetectionResult]:
        prediction = np.asarray(outputs[0])
        prediction = np.squeeze(prediction)

        if prediction.ndim == 1:
            return []
        if prediction.ndim != 2:
            raise RuntimeError(f'Unsupported YOLO output shape: {outputs[0].shape}')

        if prediction.shape[0] <= 128 and prediction.shape[1] > 128:
            prediction = prediction.T

        if prediction.shape[1] in (6, 7):
            return self._parse_end_to_end_output(prediction, original_w, original_h)

        return self._parse_raw_yolo_output(prediction, original_w, original_h, scale, pad)

    def _parse_end_to_end_output(
        self,
        prediction: np.ndarray,
        original_w: int,
        original_h: int,
    ) -> List[DetectionResult]:
        results: List[DetectionResult] = []
        for row in prediction:
            score = float(row[4])
            if score < self._conf_threshold:
                continue

            class_id = int(row[5]) if row.shape[0] >= 6 else 0
            x1 = float(np.clip(row[0], 0, original_w - 1))
            y1 = float(np.clip(row[1], 0, original_h - 1))
            x2 = float(np.clip(row[2], 0, original_w - 1))
            y2 = float(np.clip(row[3], 0, original_h - 1))
            results.append(
                DetectionResult(
                    class_id=class_id,
                    label=self._class_name(class_id),
                    score=score,
                    x1=min(x1, x2),
                    y1=min(y1, y2),
                    x2=max(x1, x2),
                    y2=max(y1, y2),
                )
            )

        results.sort(key=lambda det: det.score, reverse=True)
        return results[:self._max_detections]

    def _parse_raw_yolo_output(
        self,
        prediction: np.ndarray,
        original_w: int,
        original_h: int,
        scale: float,
        pad: Tuple[int, int],
    ) -> List[DetectionResult]:
        num_values = prediction.shape[1]
        if num_values < 5:
            return []

        if self._labels and num_values == len(self._labels) + 4:
            objectness = np.ones((prediction.shape[0],), dtype=np.float32)
            class_scores = prediction[:, 4:]
        elif self._labels and num_values == len(self._labels) + 5:
            objectness = prediction[:, 4]
            class_scores = prediction[:, 5:]
        else:
            objectness = prediction[:, 4]
            class_scores = prediction[:, 5:] if num_values > 5 else np.ones((prediction.shape[0], 1))

        if class_scores.size == 0:
            return []

        class_ids = np.argmax(class_scores, axis=1)
        class_conf = class_scores[np.arange(class_scores.shape[0]), class_ids]
        scores = objectness * class_conf
        keep = scores >= self._conf_threshold
        if not np.any(keep):
            return []

        boxes = prediction[keep, :4].astype(np.float32, copy=False)
        scores = scores[keep].astype(np.float32, copy=False)
        class_ids = class_ids[keep]

        if np.max(boxes[:, :4]) <= 2.0:
            boxes[:, 0] *= float(self._input_width)
            boxes[:, 1] *= float(self._input_height)
            boxes[:, 2] *= float(self._input_width)
            boxes[:, 3] *= float(self._input_height)

        pad_x, pad_y = pad
        x1 = (boxes[:, 0] - boxes[:, 2] * 0.5 - pad_x) / scale
        y1 = (boxes[:, 1] - boxes[:, 3] * 0.5 - pad_y) / scale
        x2 = (boxes[:, 0] + boxes[:, 2] * 0.5 - pad_x) / scale
        y2 = (boxes[:, 1] + boxes[:, 3] * 0.5 - pad_y) / scale

        x1 = np.clip(x1, 0.0, float(max(0, original_w - 1)))
        y1 = np.clip(y1, 0.0, float(max(0, original_h - 1)))
        x2 = np.clip(x2, 0.0, float(max(0, original_w - 1)))
        y2 = np.clip(y2, 0.0, float(max(0, original_h - 1)))

        nms_boxes = []
        for idx in range(scores.shape[0]):
            width = max(0.0, float(x2[idx] - x1[idx]))
            height = max(0.0, float(y2[idx] - y1[idx]))
            nms_boxes.append([float(x1[idx]), float(y1[idx]), width, height])

        selected = _flatten_indices(
            cv2.dnn.NMSBoxes(
                nms_boxes,
                scores.tolist(),
                self._conf_threshold,
                self._nms_iou_threshold,
            )
        )
        if not selected:
            return []

        detections: List[DetectionResult] = []
        for idx in selected[:self._max_detections]:
            detections.append(
                DetectionResult(
                    class_id=int(class_ids[idx]),
                    label=self._class_name(int(class_ids[idx])),
                    score=float(scores[idx]),
                    x1=float(x1[idx]),
                    y1=float(y1[idx]),
                    x2=float(x2[idx]),
                    y2=float(y2[idx]),
                )
            )

        detections.sort(key=lambda det: det.score, reverse=True)
        return detections[:self._max_detections]

    def _class_name(self, class_id: int) -> str:
        if 0 <= class_id < len(self._labels):
            return self._labels[class_id]
        return str(class_id)

    def _publish_detections(self, header: Header, detections: Sequence[DetectionResult]) -> None:
        array_msg = Detection2DArray()
        array_msg.header = header

        for index, detection in enumerate(detections):
            detection_msg = Detection2D()
            detection_msg.header = header
            detection_msg.id = f'{detection.label}_{index}'
            detection_msg.bbox.center.position.x = float(detection.center_x)
            detection_msg.bbox.center.position.y = float(detection.center_y)
            detection_msg.bbox.center.theta = 0.0
            detection_msg.bbox.size_x = float(detection.width)
            detection_msg.bbox.size_y = float(detection.height)

            hypothesis = ObjectHypothesisWithPose()
            hypothesis.hypothesis.class_id = detection.label
            hypothesis.hypothesis.score = float(detection.score)
            detection_msg.results.append(hypothesis)
            array_msg.detections.append(detection_msg)

        self._detections_pub.publish(array_msg)

    def _publish_debug_text(self, detections: Sequence[DetectionResult]) -> None:
        debug_msg = String()
        if detections:
            top = detections[0]
            summary = ', '.join(f'{det.label}:{det.score:.2f}' for det in detections[:3])
            debug_msg.data = f'top={top.label} score={top.score:.2f} total={len(detections)} [{summary}]'
            self._debug_pub.publish(debug_msg)
            return

        if self._publish_empty_debug:
            debug_msg.data = 'sin_detecciones'
            self._debug_pub.publish(debug_msg)

    def destroy_node(self) -> bool:
        self._stop_event.set()
        self._frame_event.set()
        if hasattr(self, '_worker') and self._worker.is_alive():
            self._worker.join(timeout=1.0)
        return super().destroy_node()


def main(args: Optional[Sequence[str]] = None) -> None:
    rclpy.init(args=args)
    node = YoloOnnxDetectorNode()
    executor = MultiThreadedExecutor(num_threads=2)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()

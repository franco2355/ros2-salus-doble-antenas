# lidar_camara

Semantic safety layer for SALUS: fuses LiDAR depth with YOLO camera detections.

**Status:** official implementation for this repo.  
**Design decision:** custom package chosen over `roi_pointcloud_fusion` (Autoware, not available in Docker)
and `l2d_detection` (depends on `yolo_msgs`/Ultralytics, inconsistent I/O claim).

---

## Nodes

### `fusion_node`

Combines `/detections` (YOLO) with `/scan_3d` (LiDAR) and publishes distance estimates
and a brake signal. Runs fully decoupled from the Nav2/control loop.

### `vision_brake_guard`

Consumes `/fusion/brake_active` and calls `/nav_command_server/brake` when a visually-detected
object is confirmed close by LiDAR for N consecutive frames.

---

## Topics

### Inputs

| Topic | Type | QoS |
|---|---|---|
| `/detections` | `vision_msgs/Detection2DArray` | BEST_EFFORT, depth=1 |
| `/scan_3d` | `sensor_msgs/PointCloud2` | BEST_EFFORT, depth=1 |

### Outputs

| Topic | Type | Description |
|---|---|---|
| `/fusion/targets` | `std_msgs/String` (JSON) | Per-detection label, score, azimuth, distance_m, x/y/z |
| `/fusion/brake_active` | `std_msgs/Bool` | True when closest confirmed object < `brake_distance_m` |
| `/fusion/closest_obstacle_m` | `std_msgs/Float64` | Minimum LiDAR distance to any detected object (-1 if none) |
| `/fusion/telemetry` | `std_msgs/String` (JSON) | Internal stats: frame counts, fusion count, brake events |
| `/fusion/brake_guard/status` | `std_msgs/String` (JSON) | Consecutive-frame counter, brake_active flag |

---

## Parameters

### `lidar_camara_fusion`

| Parameter | Default | Description |
|---|---|---|
| `lidar_topic` | `/scan_3d` | PointCloud2 input topic |
| `detections_topic` | `/detections` | Detection2DArray input topic |
| `camera_hfov_deg` | `90.0` | Camera horizontal FOV in degrees |
| `image_width` | `640` | Image width in pixels (used to normalize bbox center) |
| `image_height` | `360` | Image height in pixels |
| `brake_distance_m` | `2.0` | Trigger brake if confirmed object < this distance |
| `warn_distance_m` | `4.0` | Log warning if confirmed object < this distance |
| `lidar_min_range_m` | `0.3` | Ignore LiDAR points closer than this |
| `lidar_max_range_m` | `15.0` | Ignore LiDAR points farther than this |
| `azimuth_tolerance_deg` | `8.0` | Angular window for LiDAR↔detection association |
| `worker_hz` | `10.0` | Fusion worker frequency |
| `azimuth_flip` | `false` | Invert azimuth sign if LiDAR +Y points right (non-ROS convention) |

### `vision_brake_guard`

| Parameter | Default | Description |
|---|---|---|
| `brake_service` | `/nav_command_server/brake` | Service to call on brake |
| `brake_active_topic` | `/fusion/brake_active` | Input topic |
| `cooldown_s` | `3.0` | Minimum seconds between brake calls |
| `require_consecutive` | `3` | Number of consecutive True frames before calling brake |

---

## QoS policy

Both input subscriptions use **BEST_EFFORT / KEEP_LAST=1 / VOLATILE**.

Rationale: in a safety-by-geometry system (LiDAR costmaps + `collision_monitor` handle
geometric safety), the semantic camera layer prioritises *freshness* over *completeness*.
A stale frame from 200 ms ago is worse than no frame; dropping it is correct.

`vision_brake_guard` output (`/fusion/brake_guard/status`) and inputs are also depth=1
BEST_EFFORT — brake decisions use the latest state, not accumulated history.

---

## Threading model

```
ROS 2 executor (MultiThreadedExecutor, 3 threads)
  ├── MutuallyExclusiveCallbackGroup A  →  _on_detections()   stores latest Detection2DArray
  └── MutuallyExclusiveCallbackGroup B  →  _on_cloud()        stores latest PointCloud2

OS thread: fusion-worker  (runs at worker_hz, independent of executor)
  reads _latest_detections + _latest_cloud under threading.Lock
  runs association logic
  publishes /fusion/* topics
```

The two callback groups ensure LiDAR and camera callbacks never block each other.
The worker thread is fully decoupled from ROS 2 callbacks so that inference time
does not affect subscriber latency or the control/navigation loop.

---

## Latest-frame-only policy

Callbacks store **only the most recent message** and return immediately:

```python
def _on_detections(self, msg):
    with self._det_lock:
        self._latest_detections = msg   # overwrite; old msg is discarded

def _on_cloud(self, msg):
    with self._cloud_lock:
        self._latest_cloud = msg
```

There is **no** `ApproximateTimeSynchronizer` or message queue.  
Consequence: the worker always operates on the freshest available data from each sensor,
even if their timestamps are slightly misaligned. This trades temporal accuracy for
latency and simplicity, which is acceptable for a brake-guard layer.

---

## Association method: azimuth sector matching

For each YOLO detection, `fusion_node` estimates the object's azimuth angle from
the bounding-box center:

```
cx_norm  = bbox.center.position.x / image_width    # [0, 1]
cam_az   = (cx_norm - 0.5) * camera_hfov_deg       # degrees, 0 = camera center
lidar_az = -cam_az_rad                              # ROS: +x forward, +y left
                                                    # cam right → robot -y → negative az
```

LiDAR points whose azimuth falls within `±azimuth_tolerance_deg` of `lidar_az`,
are in the forward half-space (`x > 0`), and within `[lidar_min_range_m, lidar_max_range_m]`
are selected. The **minimum range** among those points is used as the object distance.

### Geometric limitations

1. **No camera calibration used.** The association relies on `camera_hfov_deg` only.
   A mis-specified FOV shifts all azimuth estimates proportionally.

2. **No extrinsic calibration.** The method assumes LiDAR and camera share the same
   forward axis and horizontal plane. Any physical offset or angular misalignment
   between them is not compensated — it appears as a systematic azimuth error.

3. **No vertical (elevation) filtering.** LiDAR points are only filtered by azimuth,
   not by elevation. A low obstacle on the ground and a high obstacle at the same azimuth
   are treated identically.

4. **No pinhole projection.** The correct approach (future improvement) is to project
   each LiDAR point into the image plane using `image_geometry.PinholeCameraModel`
   and check if the projected pixel falls inside the detection bounding box.
   That requires a valid `sensor_msgs/CameraInfo` and a TF from `lidar_link` to
   `camera_optical_frame`.

5. **Azimuth ambiguity at large distances.** At 15 m with 8° tolerance, the sector
   width is ≈2.1 m — wide enough to include unrelated objects at the same azimuth.
   Reduce `azimuth_tolerance_deg` and `lidar_max_range_m` for denser environments.

---

## Brake criterion

```
brake_active = True  iff  (any detected object has a LiDAR-confirmed distance)
                          AND (that distance < brake_distance_m)
```

`vision_brake_guard` adds hysteresis: it calls `/nav_command_server/brake` only after
`require_consecutive` consecutive True frames AND after `cooldown_s` has elapsed since
the last brake call. This avoids false positives from single noisy frames and prevents
hammering the service.

The brake is **semantic**, not geometric: it fires when the camera recognises an object
(person, vehicle, obstacle) AND LiDAR confirms it is close. LiDAR-only geometric safety
is handled upstream by Nav2's `collision_monitor`.

---

## How to run

**Fusion only (no brake calls):**
```bash
source /ros2_ws/install/setup.bash
ros2 launch lidar_camara lidar_camara.launch.py
```

**With brake guard active** (requires `nav_command_server` running):
```bash
ros2 launch lidar_camara lidar_camara.launch.py enable_brake_guard:=true
```

**Custom params file:**
```bash
ros2 launch lidar_camara lidar_camara.launch.py \
  params_file:=/path/to/my_params.yaml \
  enable_brake_guard:=true
```

**Monitor outputs:**
```bash
ros2 topic echo /fusion/targets
ros2 topic echo /fusion/brake_active
ros2 topic hz /fusion/closest_obstacle_m
```

---

## CameraInfo (optional, for downstream use)

`ip_camera_publisher` can co-publish `sensor_msgs/CameraInfo` on `/camera/camera_info`
by setting `publish_camera_info:=true`. Intrinsics default to a 90° FOV estimate;
replace with real calibration values for accurate pinhole projection.

```bash
ros2 run vision_pipeline ip_camera_publisher --ros-args \
  -p stream_url:=http://localhost:8089/snap.jpg \
  -p publish_camera_info:=true \
  -p camera_hfov_deg:=90.0 \
  -p camera_fx:=320.0 \
  -p camera_fy:=320.0
```

---

## Future improvements (not implemented)

- Replace azimuth association with pinhole projection using `image_geometry` + `CameraInfo` + TF.
- Add elevation filtering (ignore ground-plane LiDAR returns).
- Add object tracking ID to `/fusion/targets` for temporal consistency.
- Optionally publish a debug `sensor_msgs/Image` with projected LiDAR points overlaid.

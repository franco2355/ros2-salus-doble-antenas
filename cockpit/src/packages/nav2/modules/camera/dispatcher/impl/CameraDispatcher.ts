import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

/**
 * CameraDispatcher handles messages bridged from two ROS 2 topics:
 *   /camera/image_raw  → op "camera_frame"
 *   /detections        → op "camera_detections"
 *
 * It is registered on the same transport (transport.ws.core) as RobotDispatcher.
 * The DispatchRouter fans out every incoming message to all dispatchers on the
 * transport, so this dispatcher only acts on the ops it cares about.
 */
export class CameraDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  /**
   * Subscribe to camera frames published by the backend from /camera/image_raw.
   *
   * Expected message payload fields (all at top level or inside `payload`):
   *   data:      string  – base64-encoded JPEG/PNG image bytes
   *   stamp_ms:  number  – ROS2 header stamp converted to epoch-ms
   *   width:     number  – image width in pixels
   *   height:    number  – image height in pixels
   *   encoding:  string  – "jpeg" | "png" | "rgb8" (optional hint)
   */
  subscribeFrame(callback: (msg: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("camera_frame", callback);
  }

  /**
   * Subscribe to detection results published by the backend from /detections.
   *
   * Expected message payload fields (all at top level or inside `payload`):
   *   detections: Detection[]  – array of detected objects (format TBD, see CameraVisionService parser)
   *   stamp_ms:   number       – timestamp of the source image that produced these detections (epoch-ms)
   *
   * NOTE: /detections does NOT produce detections by itself. The backend detector
   * reads /camera/image_raw, runs inference, and publishes results to /detections.
   * Both this op and camera_frame should be consumed together and synced via stamp_ms.
   */
  subscribeDetections(callback: (msg: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("camera_detections", callback);
  }
}

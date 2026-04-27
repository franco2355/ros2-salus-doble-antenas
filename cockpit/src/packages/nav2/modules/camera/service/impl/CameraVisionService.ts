import type { CameraDispatcher } from "../../dispatcher/impl/CameraDispatcher";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single camera frame received from the backend (/camera/image_raw bridge).
 */
export interface CameraFrame {
  imageBase64: string;
  encoding: string;
  mimeType: string;
  stampMs: number;
  width: number;
  height: number;
}

/**
 * Bounding box in NORMALIZED image coordinates (all values 0..1).
 *  x, y = top-left corner
 *  w, h = width and height
 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A single detected object.
 *
 * TODO: Adjust the fields inside parseRawDetection() below when the backend
 *       /detections message format is confirmed.
 */
export interface Detection {
  /** Human-readable class label, e.g. "person", "car" */
  class: string;
  /** Detection confidence in range [0, 1] */
  confidence: number;
  /** Bounding box in normalized image coords */
  bbox: BBox;
}

/**
 * Observable state exposed to React components.
 */
export interface CameraVisionState {
  /** True while camera frames are arriving (resets after CAMERA_TIMEOUT_MS with no frames) */
  connected: boolean;
  /** True while detections are fresh (resets after DETECTION_STALE_MS) */
  detectionsActive: boolean;
  /** Most recent frame, or null if none received yet */
  currentFrame: CameraFrame | null;
  /** Detections matched to the current frame (may be empty) */
  currentDetections: Detection[];
  /** Number of detections in the current set */
  detectionCount: number;
  /** Approximate frames-per-second, updated every second */
  fps: number;
  /** Epoch-ms of last received frame (0 = never) */
  lastFrameMs: number;
  /** Epoch-ms of last received detection batch (0 = never) */
  lastDetectionMs: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DetectionBatch {
  detections: Detection[];
  stampMs: number;
}

type Listener = (state: CameraVisionState) => void;

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** How many recent frames to keep in the buffer for timestamp matching */
const FRAME_BUFFER_SIZE = 10;

/** Maximum timestamp difference (ms) to consider a frame and detection batch as paired */
const MATCH_THRESHOLD_MS = 250;

/** After this many ms with no new frame, mark camera as disconnected */
const CAMERA_TIMEOUT_MS = 3000;

/** After this many ms with no new detections, mark detections as inactive */
const DETECTION_STALE_MS = 2000;

/** How often to run the staleness check (ms) */
const STALE_CHECK_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Detection parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw unknown object into a Detection.
 * Returns null if the object cannot be interpreted.
 *
 * TODO: This parser covers common formats (flat YOLO-style, ROS2 vision_msgs style).
 *       Add or adjust branches when your backend's /detections format is known.
 *
 * Supported layouts:
 *
 *  Flat YOLO-style:
 *    { class: "person", confidence: 0.95, bbox: [x, y, w, h] }    (normalized)
 *    { label: "person", score: 0.95, bbox: [x1, y1, x2, y2] }     (absolute or normalized)
 *    { class_name: "person", prob: 0.95, x: 0.4, y: 0.35, w: 0.2, h: 0.3 }
 *
 *  vision_msgs/Detection2D style:
 *    {
 *      results: [{ hypothesis: { class_id: "person", score: 0.95 } }],
 *      bbox: { center: { position: { x: 0.5, y: 0.5 } }, size_x: 0.2, size_y: 0.3 }
 *    }
 */
function parseRawDetection(raw: unknown): Detection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // --- Class label ---
  const classLabel =
    typeof r.class === "string" ? r.class :
    typeof r.label === "string" ? r.label :
    typeof r.class_name === "string" ? r.class_name :
    typeof r.category === "string" ? r.category :
    resolveVisionMsgsClass(r) ??
    "unknown";

  // --- Confidence ---
  const rawConf =
    typeof r.confidence === "number" ? r.confidence :
    typeof r.score === "number" ? r.score :
    typeof r.prob === "number" ? r.prob :
    typeof r.probability === "number" ? r.probability :
    resolveVisionMsgsScore(r) ??
    0;
  const confidence = Math.max(0, Math.min(1, rawConf));

  // --- Bounding box ---
  const bbox = parseBBox(r);
  if (!bbox) return null;

  return { class: classLabel, confidence, bbox };
}

function resolveVisionMsgsClass(r: Record<string, unknown>): string | null {
  const results = Array.isArray(r.results) ? r.results : null;
  if (!results || results.length === 0) return null;
  const first = results[0] as Record<string, unknown> | null;
  if (!first) return null;
  const hyp = first.hypothesis as Record<string, unknown> | null;
  if (!hyp) return null;
  return typeof hyp.class_id === "string" ? hyp.class_id : null;
}

function resolveVisionMsgsScore(r: Record<string, unknown>): number | null {
  const results = Array.isArray(r.results) ? r.results : null;
  if (!results || results.length === 0) return null;
  const first = results[0] as Record<string, unknown> | null;
  if (!first) return null;
  const hyp = first.hypothesis as Record<string, unknown> | null;
  if (!hyp) return null;
  return typeof hyp.score === "number" ? hyp.score : null;
}

/**
 * Parse a bounding box from a detection record.
 *
 * Supports:
 *   bbox: [x, y, w, h]            flat array, assumed normalized 0..1 (top-left + size)
 *   bbox: [x1, y1, x2, y2]        flat array, if x2 > 1 it's absolute pixels (converted)
 *   { x, y, w, h }                flat fields, normalized
 *   { cx, cy, w, h }              center-based, normalized
 *   vision_msgs bbox object
 *
 * TODO: If your backend sends absolute pixel coordinates, you will need to know
 *       the image width/height to normalize. Currently we assume normalized inputs.
 *       If coordinates > 1 are detected, they are passed through as-is until the
 *       TODO below is resolved.
 */
function parseBBox(r: Record<string, unknown>): BBox | null {
  // Array form: bbox: [x, y, w, h]
  if (Array.isArray(r.bbox) && r.bbox.length >= 4) {
    const [a, b, c, d] = r.bbox as number[];
    // Heuristic: if values look like x1,y1,x2,y2 (second pair > first)
    if (c > a && d > b && a <= 1 && b <= 1) {
      return { x: a, y: b, w: c - a, h: d - b };
    }
    return { x: a, y: b, w: c, h: d };
  }

  // Flat numeric fields: { x, y, w, h }
  if (typeof r.x === "number" && typeof r.y === "number" &&
      typeof r.w === "number" && typeof r.h === "number") {
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  // Center-based fields: { cx, cy, w, h }
  if (typeof r.cx === "number" && typeof r.cy === "number" &&
      typeof r.w === "number" && typeof r.h === "number") {
    return { x: r.cx - r.w / 2, y: r.cy - r.h / 2, w: r.w, h: r.h };
  }

  // vision_msgs/Detection2D bbox object
  if (r.bbox && typeof r.bbox === "object" && !Array.isArray(r.bbox)) {
    const bboxObj = r.bbox as Record<string, unknown>;
    const center = bboxObj.center as Record<string, unknown> | null;
    const pos = center?.position as Record<string, unknown> | null;
    const cx = typeof pos?.x === "number" ? pos.x : null;
    const cy = typeof pos?.y === "number" ? pos.y : null;
    const sw = typeof bboxObj.size_x === "number" ? bboxObj.size_x : null;
    const sh = typeof bboxObj.size_y === "number" ? bboxObj.size_y : null;
    if (cx !== null && cy !== null && sw !== null && sh !== null) {
      return { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CameraVisionService {
  private readonly frameBuffer: CameraFrame[] = [];
  private lastDetectionBatch: DetectionBatch | null = null;
  private state: CameraVisionState;
  private readonly listeners = new Set<Listener>();

  // FPS tracking
  private frameCount = 0;
  private fpsWindowStart = Date.now();
  private lastComputedFps = 0;

  // Stale-state cleanup timer
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dispatcher: CameraDispatcher) {
    this.state = {
      connected: false,
      detectionsActive: false,
      currentFrame: null,
      currentDetections: [],
      detectionCount: 0,
      fps: 0,
      lastFrameMs: 0,
      lastDetectionMs: 0
    };

    dispatcher.subscribeFrame((msg) => this.handleFrame(msg));
    dispatcher.subscribeDetections((msg) => this.handleDetections(msg));

    this.staleCheckTimer = setInterval(() => this.runStaleCheck(), STALE_CHECK_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getState(): CameraVisionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.staleCheckTimer !== null) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private handleFrame(msg: Nav2IncomingMessage): void {
    const nowMs = Date.now();

    // Extract fields from top-level message (Nav2DispatcherBase flattens payload fields)
    const data =
      typeof msg.data === "string" ? msg.data :
      typeof (msg.payload as Record<string, unknown> | null)?.data === "string"
        ? (msg.payload as Record<string, unknown>).data as string
        : null;

    if (!data) return;

    const stampMs = resolveStampMs(msg, nowMs);
    const encoding = resolveFrameEncoding(msg);
    const width = Number(
      msg.width ?? (msg.payload as Record<string, unknown> | null)?.width ?? 640
    );
    const height = Number(
      msg.height ?? (msg.payload as Record<string, unknown> | null)?.height ?? 480
    );

    const frame: CameraFrame = {
      imageBase64: data,
      encoding,
      mimeType: resolveFrameMimeType(encoding),
      stampMs,
      width: width > 0 ? width : 640,
      height: height > 0 ? height : 480
    };

    // Push to buffer, evict oldest if needed
    this.frameBuffer.push(frame);
    if (this.frameBuffer.length > FRAME_BUFFER_SIZE) {
      this.frameBuffer.shift();
    }

    // FPS: count frames over a 1-second window
    this.frameCount++;
    const elapsed = nowMs - this.fpsWindowStart;
    if (elapsed >= 1000) {
      this.lastComputedFps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount = 0;
      this.fpsWindowStart = nowMs;
    }

    // Match the latest detection batch to this frame
    const matched = this.matchDetectionsToFrame(frame, nowMs);

    this.state = {
      ...this.state,
      connected: true,
      currentFrame: frame,
      currentDetections: matched,
      detectionCount: matched.length,
      fps: this.lastComputedFps,
      lastFrameMs: nowMs
    };

    this.notify();
  }

  private handleDetections(msg: Nav2IncomingMessage): void {
    const nowMs = Date.now();
    const stampMs = resolveStampMs(msg, nowMs);

    const rawDetections: unknown =
      msg.detections ??
      (msg.payload as Record<string, unknown> | null)?.detections;

    if (!Array.isArray(rawDetections)) return;

    const detections = rawDetections
      .map(parseRawDetection)
      .filter((d): d is Detection => d !== null);

    this.lastDetectionBatch = { detections, stampMs };

    this.state = {
      ...this.state,
      connected: true,
      detectionsActive: true,
      currentDetections: detections,
      detectionCount: detections.length,
      lastDetectionMs: nowMs
    };

    this.notify();
  }

  // -------------------------------------------------------------------------
  // Buffer + matching logic
  // -------------------------------------------------------------------------

  /** Find which detections (if any) pair with the given frame */
  private matchDetectionsToFrame(frame: CameraFrame, nowMs: number): Detection[] {
    if (!this.lastDetectionBatch) return [];

    // Discard detections that are too old wall-clock-wise
    if (nowMs - this.lastDetectionBatch.stampMs > DETECTION_STALE_MS) return [];

    // Check timestamp proximity
    const diff = Math.abs(frame.stampMs - this.lastDetectionBatch.stampMs);
    return diff <= MATCH_THRESHOLD_MS ? this.lastDetectionBatch.detections : [];
  }

  /** Find the buffered frame whose stamp is closest to the given stamp */
  private findBestFrame(stampMs: number): CameraFrame | null {
    if (this.frameBuffer.length === 0) return null;

    let best: CameraFrame | null = null;
    let bestDiff = Infinity;

    for (const frame of this.frameBuffer) {
      const diff = Math.abs(frame.stampMs - stampMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = frame;
      }
    }

    return bestDiff <= MATCH_THRESHOLD_MS ? best : null;
  }

  // -------------------------------------------------------------------------
  // Staleness check
  // -------------------------------------------------------------------------

  private runStaleCheck(): void {
    const nowMs = Date.now();
    let changed = false;
    let next = this.state;

    // Camera timeout
    if (next.connected && next.lastFrameMs > 0 && nowMs - next.lastFrameMs > CAMERA_TIMEOUT_MS) {
      next = { ...next, connected: false, fps: 0 };
      changed = true;
    }

    // Detection staleness
    if (next.detectionsActive && next.lastDetectionMs > 0 &&
        nowMs - next.lastDetectionMs > DETECTION_STALE_MS) {
      next = {
        ...next,
        detectionsActive: false,
        currentDetections: [],
        detectionCount: 0
      };
      changed = true;
    }

    if (changed) {
      this.state = next;
      this.notify();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private notify(): void {
    this.listeners.forEach((l) => l(this.state));
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function resolveStampMs(msg: Nav2IncomingMessage, fallback: number): number {
  const candidate =
    msg.stamp_ms ??
    (msg.payload as Record<string, unknown> | null)?.stamp_ms ??
    msg.stamp ??
    (msg.payload as Record<string, unknown> | null)?.stamp;

  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveFrameEncoding(msg: Nav2IncomingMessage): string {
  const candidate =
    msg.encoding ??
    (msg.payload as Record<string, unknown> | null)?.encoding;
  if (typeof candidate !== "string") return "jpeg";
  const normalized = candidate.trim().toLowerCase();
  if (normalized === "png") return "png";
  if (normalized === "jpg" || normalized === "jpeg") return "jpeg";
  return "jpeg";
}

function resolveFrameMimeType(encoding: string): string {
  return encoding === "png" ? "image/png" : "image/jpeg";
}

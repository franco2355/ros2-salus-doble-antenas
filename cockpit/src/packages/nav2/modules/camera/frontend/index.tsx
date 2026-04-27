import { useEffect, useRef, useState, type ReactNode } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { CameraDispatcher } from "../dispatcher/impl/CameraDispatcher";
import {
  CameraVisionService,
  type BBox,
  type CameraVisionState,
  type Detection
} from "../service/impl/CameraVisionService";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { NavigationService, type NavigationState } from "../../navigation/service/impl/NavigationService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.camera";
const SERVICE_ID = "service.camera-vision";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";

// ---------------------------------------------------------------------------
// Canvas overlay drawing
// ---------------------------------------------------------------------------

const BBOX_COLOR = "#8be3ff";
const LABEL_BG = "rgba(7, 17, 26, 0.92)";
const LABEL_TEXT = "#e8fbff";
const BBOX_LINE_WIDTH = 2;
const FONT = "bold 11px monospace";
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 3;
const LABEL_HEIGHT = 17;

/**
 * Draw a single detection bounding box + label on the canvas context.
 * drawX/drawY/drawW/drawH describe the image's actual rendered region within
 * the canvas (after accounting for letterboxing from object-fit: contain).
 */
function drawDetection(
  ctx: CanvasRenderingContext2D,
  det: Detection,
  drawX: number,
  drawY: number,
  drawW: number,
  drawH: number
): void {
  const bbox: BBox = det.bbox;
  const px = drawX + bbox.x * drawW;
  const py = drawY + bbox.y * drawH;
  const pw = bbox.w * drawW;
  const ph = bbox.h * drawH;

  // Bounding box
  ctx.strokeStyle = BBOX_COLOR;
  ctx.lineWidth = BBOX_LINE_WIDTH;
  ctx.strokeRect(px, py, pw, ph);

  // Label
  const label = `${det.class}  ${(det.confidence * 100).toFixed(0)}%`;
  ctx.font = FONT;
  const metrics = ctx.measureText(label);
  const labelW = metrics.width + LABEL_PAD_X * 2;
  const lx = px;
  const ly = py - LABEL_HEIGHT;

  ctx.fillStyle = LABEL_BG;
  ctx.fillRect(lx, ly < 0 ? py : ly, labelW, LABEL_HEIGHT - LABEL_PAD_Y);

  ctx.fillStyle = LABEL_TEXT;
  ctx.fillText(label, lx + LABEL_PAD_X, ly < 0 ? py + LABEL_HEIGHT - LABEL_PAD_Y - 3 : ly + LABEL_HEIGHT - LABEL_PAD_Y - 2);
}

/**
 * Render all detection overlays onto the canvas.
 * Computes the actual image draw region accounting for object-fit: contain.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  detections: Detection[],
  imgNaturalW: number,
  imgNaturalH: number
): void {
  const containerW = canvas.clientWidth;
  const containerH = canvas.clientHeight;

  canvas.width = containerW;
  canvas.height = containerH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, containerW, containerH);
  if (detections.length === 0) return;

  // Compute the rendered image region (letterboxed inside the container)
  const natW = imgNaturalW > 0 ? imgNaturalW : 640;
  const natH = imgNaturalH > 0 ? imgNaturalH : 480;
  const containerAspect = containerW / containerH;
  const imageAspect = natW / natH;

  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (containerAspect > imageAspect) {
    // Letterbox on left + right
    drawH = containerH;
    drawW = drawH * imageAspect;
    drawX = (containerW - drawW) / 2;
    drawY = 0;
  } else {
    // Letterbox on top + bottom
    drawW = containerW;
    drawH = drawW / imageAspect;
    drawX = 0;
    drawY = (containerH - drawH) / 2;
  }

  for (const det of detections) {
    drawDetection(ctx, det, drawX, drawY, drawW, drawH);
  }
}

function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "Waiting";
  return new Date(timestampMs).toLocaleTimeString();
}

function StatusCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
  variant = "metric",
  compact = false
}: {
  label: string;
  value: string;
  detail?: string;
  icon?: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "off";
  variant?: "metric" | "state";
  compact?: boolean;
}): JSX.Element {
  return (
    <div className={`cv-status-card cv-status-card-${tone} cv-status-card-${variant}${compact ? " cv-status-card-compact" : ""}`}>
      {icon ? <span className="cv-status-card-icon" aria-hidden="true">{icon}</span> : null}
      <span className="cv-status-card-label">{label}</span>
      <strong className="cv-status-card-value">
        {variant === "state" ? <span className="cv-state-value">{value}</span> : value}
      </strong>
      {detail ? <span className="cv-status-card-detail">{detail}</span> : null}
    </div>
  );
}

function PtzDirectionIcon({ rotation }: { rotation: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M12 4v13" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  );
}

function PtzZoomIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15L20.5 20.5" />
    </svg>
  );
}

function PtzButton({
  icon,
  label,
  title,
  className,
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  title: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`cv-ptz-btn${className ? ` ${className}` : ""}`}
      onClick={onClick}
      aria-label={title}
      disabled={disabled}
    >
      <span className="cv-ptz-btn-shell">
        <span className="cv-ptz-btn-arrow" aria-hidden="true">
          {icon}
        </span>
        <span className="cv-ptz-btn-caption">{label}</span>
      </span>
    </button>
  );
}

function RailFeedRow({
  label,
  value,
  detail,
  tone = "neutral",
  icon
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "ok" | "warn" | "off";
  icon?: ReactNode;
}): JSX.Element {
  return (
    <div className={`cv-rail-feed-row cv-rail-feed-row-${tone}`}>
      {icon ? <span className="cv-rail-feed-icon" aria-hidden="true">{icon}</span> : null}
      <span className="cv-rail-feed-label">{label}</span>
      <strong className="cv-rail-feed-value">{value}</strong>
      {detail ? <span className="cv-rail-feed-detail">{detail}</span> : null}
    </div>
  );
}

const SNAP_URL = "http://localhost:8089/snap.jpg";

function CameraVisionWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<CameraVisionService>(SERVICE_ID);
  let navigationService: NavigationService | null = null;
  let connectionService: ConnectionService | null = null;
  try {
    navigationService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [state, setState] = useState<CameraVisionState>(service.getState());
  const [navigationState, setNavigationState] = useState<NavigationState | null>(navigationService?.getState() ?? null);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(connectionService?.getState() ?? null);
  const [snapSrc, setSnapSrc] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  // Direct snapshot polling — bypasses WebSocket/ROS entirely
  useEffect(() => {
    let cancelled = false;
    function poll(): void {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => { if (!cancelled) { setSnapSrc(img.src); poll(); } };
      img.onerror = () => { if (!cancelled) setTimeout(poll, 300); };
      img.src = `${SNAP_URL}?_=${Date.now()}`;
    }
    poll();
    return () => { cancelled = true; };
  }, []);

  const redrawOverlay = (): void => {
    const canvas = canvasRef.current;
    const imgEl = imgRef.current;
    if (!canvas) return;
    const natW = imgEl?.naturalWidth ?? 0;
    const natH = imgEl?.naturalHeight ?? 0;
    renderOverlay(canvas, state.currentDetections, natW, natH);
  };

  useEffect(() => {
    redrawOverlay();
  }, [snapSrc, state.currentDetections]);

  useEffect(() => {
    const handleResize = (): void => {
      redrawOverlay();
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [snapSrc, state.currentDetections]);

  const detCountText = `${state.detectionCount} obj${state.detectionCount !== 1 ? "s" : ""}`;
  const frameResolution = state.currentFrame
    ? `${state.currentFrame.width} x ${state.currentFrame.height}`
    : "Snapshot feed";
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const streamOnline = navigationState?.cameraStreamConnected === true;
  const presetLabel = connectionState?.preset === "sim" ? "SIM" : connectionState?.preset === "real" ? "REAL" : "N/A";
  const lastFrameLabel = formatTimestamp(state.lastFrameMs);
  const lastDetectionLabel = formatTimestamp(state.lastDetectionMs);
  const ptzDisabled = !navigationService || !cameraEnabled;

  const pan = async (angleDeg: number): Promise<void> => {
    if (!navigationService) return;
    if (!connectionService?.isCameraEnabled()) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Camera disabled in current preset",
        timestamp: Date.now()
      });
      return;
    }
    try {
      await navigationService.panCamera(angleDeg);
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera pan failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  const toggleZoom = async (): Promise<void> => {
    if (!navigationService) return;
    try {
      await navigationService.toggleCameraZoom();
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera zoom failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  return (
    <div className="cv-root cv-html-root">
      <div className="cv-body cv-html-body">
        <section className="cv-main cv-html-main">
          <div className="cv-viewport-shell cv-html-stage">
            <div className={`cv-viewport cv-html-viewport${!snapSrc ? " cv-viewport--no-signal" : ""}`}>
              {snapSrc ? (
                <img
                  ref={imgRef}
                  src={snapSrc}
                  className="cv-frame"
                  alt="Camera stream"
                  draggable={false}
                  onLoad={redrawOverlay}
                />
              ) : (
                <div className="cv-no-signal">
                  <div className="cv-no-signal-shell">
                    <div className="cv-no-signal-text">Awaiting camera snapshot</div>
                  </div>
                </div>
              )}
              <canvas ref={canvasRef} className="cv-overlay" />
              {state.connected ? <div className="cv-html-rec">● LIVE</div> : null}
            </div>
          </div>
        </section>

        <aside className="cv-panel cv-html-panel cv-control-rail">
          <div className="cv-panel-scroll cv-control-rail-scroll">
            <section className="cv-panel-section cv-rail-section cv-rail-overview-section">
              <div className="cv-panel-header cv-overview-header">
                <span className="cv-overview-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                    <path d="M4 7.5h2.2l1.1-1.8h5.4l1.1 1.8H16a1.7 1.7 0 0 1 1.7 1.7v4.5a1.7 1.7 0 0 1-1.7 1.7H4a1.7 1.7 0 0 1-1.7-1.7V9.2A1.7 1.7 0 0 1 4 7.5Z" />
                    <circle cx="10" cy="11.5" r="2.4" />
                  </svg>
                </span>
                <span className="cv-overview-header-title">Camera overview</span>
                <span className="cv-panel-caption cv-overview-header-signal" aria-label="Vision status">
                  <svg viewBox="0 0 30 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="25" height="14">
                    <path d="M2 8h5l2.2-5 3.8 10 2.4-5H28" />
                  </svg>
                </span>
              </div>
              <div className="cv-rail-overview">
                <div className={`cv-rail-primary ${state.connected ? "cv-rail-primary-ok" : "cv-rail-primary-off"}`}>
                  <span className="cv-rail-primary-dot" aria-hidden="true" />
                  <div className="cv-rail-primary-copy">
                    <span className="cv-rail-kicker">Primary feed</span>
                    <strong>{state.connected ? "Online" : "Offline"}</strong>
                    <span>{state.connected ? "Frames arriving" : "No fresh frames"}</span>
                  </div>
                  <div className="cv-rail-primary-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                      <circle cx="12" cy="13" r="4"/>
                    </svg>
                  </div>
                </div>

                <div className="cv-rail-state-row">
                  <span className={`cv-rail-state-pill ${cameraEnabled ? "cv-rail-state-pill-ok" : "cv-rail-state-pill-off"}`}>
                    <span aria-hidden="true" />
                    {cameraEnabled ? "Camera enabled" : "Camera disabled"}
                  </span>
                  <span className={`cv-rail-state-pill ${streamOnline ? "cv-rail-state-pill-ok" : "cv-rail-state-pill-warn"}`}>
                    <span aria-hidden="true" />
                    {streamOnline ? "Stream live" : "Stream standby"}
                  </span>
                </div>

                <div className="cv-rail-metric-grid">
                  <StatusCard
                    label="Objects"
                    value={String(state.detectionCount)}
                    detail={detCountText}
                    tone={state.detectionCount > 0 ? "warn" : "neutral"}
                    icon={<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="17" height="17"><path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6L10 2.5Z" /><path d="M10 10 16.5 6" /><path d="M10 10 3.5 6" /><path d="M10 10v7.5" /></svg>}
                    compact
                  />
                  <StatusCard
                    label="FPS"
                    value={state.fps > 0 ? `${state.fps}` : "—"}
                    detail="Current"
                    tone={state.fps > 0 ? "ok" : "neutral"}
                    icon={<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="17" height="17"><path d="M4.1 14.5a7 7 0 1 1 11.8 0" /><path d="M10 10.5 13.5 7" /><path d="M10 3.8v1.7" /><path d="M4.9 8.9h1.7" /><path d="M13.4 8.9h1.7" /></svg>}
                    compact
                  />
                  <StatusCard
                    label="Detections"
                    value={state.detectionsActive ? "Live" : "Idle"}
                    detail={state.detectionsActive ? "Overlay" : "Waiting"}
                    tone={state.detectionsActive ? "warn" : "neutral"}
                    variant="state"
                    icon={<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="17" height="17"><path d="M6.2 3.2H4.7a1.5 1.5 0 0 0-1.5 1.5v1.5" /><path d="M13.8 3.2h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5" /><path d="M16.8 13.8v1.5a1.5 1.5 0 0 1-1.5 1.5h-1.5" /><path d="M6.2 16.8H4.7a1.5 1.5 0 0 1-1.5-1.5v-1.5" /><circle cx="10" cy="10" r="2.5" /></svg>}
                    compact
                  />
                </div>
              </div>
            </section>

            <section className="cv-panel-section cv-rail-section cv-rail-ptz-section">
              <div className="cv-panel-header cv-ptz-section-header">
                <span className="cv-ptz-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                    <circle cx="10" cy="10" r="6.5"/>
                    <circle cx="10" cy="10" r="3"/>
                    <line x1="10" y1="1" x2="10" y2="4.5"/>
                    <line x1="10" y1="15.5" x2="10" y2="19"/>
                    <line x1="1" y1="10" x2="4.5" y2="10"/>
                    <line x1="15.5" y1="10" x2="19" y2="10"/>
                  </svg>
                </span>
                <span>Camera PTZ</span>
                <span className="cv-panel-caption">PAN / ZOOM</span>
              </div>
              <div className="cv-ptz-panel cv-ptz-panel-compact">
                <div className="cv-ptz-widget">
                  {/* Left wing — NW · SW only */}
                  <div className="cv-ptz-wing cv-ptz-wing-left">
                    <div className="cv-ptz-dial-btn cv-ptz-dial-btn-nw">
                      <PtzButton icon={<PtzDirectionIcon rotation={-45} />} label="NW" title="Pan northwest" disabled={ptzDisabled} onClick={() => void pan(135)} />
                    </div>
                    <div className="cv-ptz-dial-btn cv-ptz-dial-btn-sw">
                      <PtzButton icon={<PtzDirectionIcon rotation={-135} />} label="SW" title="Pan southwest" disabled={ptzDisabled} onClick={() => void pan(-135)} />
                    </div>
                  </div>
                  {/* Core — dial only; N/E/S/W sit on the ring */}
                  <div className="cv-ptz-core">
                    <div className="cv-ptz-dial">
                      <div className="cv-ptz-dial-ring" aria-hidden="true">
                        <span className="cv-ptz-dial-tick cv-ptz-dial-tick-n" />
                        <span className="cv-ptz-dial-tick cv-ptz-dial-tick-e" />
                        <span className="cv-ptz-dial-tick cv-ptz-dial-tick-s" />
                        <span className="cv-ptz-dial-tick cv-ptz-dial-tick-w" />
                      </div>
                      <div className="cv-ptz-dial-center">
                        <PtzButton icon={<PtzZoomIcon />} label="Zoom" title="Toggle camera zoom" className="cv-ptz-btn-center" disabled={!navigationService} onClick={() => void toggleZoom()} />
                      </div>
                      {/* Cardinal buttons — center aligned with the outer ring edge */}
                      <div className="cv-ptz-cardinal cv-ptz-cardinal-n">
                        <PtzButton icon={<PtzDirectionIcon rotation={0} />} label="N" title="Pan north" disabled={ptzDisabled} onClick={() => void pan(90)} />
                      </div>
                      <div className="cv-ptz-cardinal cv-ptz-cardinal-e">
                        <PtzButton icon={<PtzDirectionIcon rotation={90} />} label="E" title="Pan east" disabled={ptzDisabled} onClick={() => void pan(0)} />
                      </div>
                      <div className="cv-ptz-cardinal cv-ptz-cardinal-s">
                        <PtzButton icon={<PtzDirectionIcon rotation={180} />} label="S" title="Pan south" disabled={ptzDisabled} onClick={() => void pan(-90)} />
                      </div>
                      <div className="cv-ptz-cardinal cv-ptz-cardinal-w">
                        <PtzButton icon={<PtzDirectionIcon rotation={-90} />} label="W" title="Pan west" disabled={ptzDisabled} onClick={() => void pan(180)} />
                      </div>
                    </div>
                  </div>
                  {/* Right wing — NE · SE only */}
                  <div className="cv-ptz-wing cv-ptz-wing-right">
                    <div className="cv-ptz-dial-btn cv-ptz-dial-btn-ne">
                      <PtzButton icon={<PtzDirectionIcon rotation={45} />} label="NE" title="Pan northeast" disabled={ptzDisabled} onClick={() => void pan(45)} />
                    </div>
                    <div className="cv-ptz-dial-btn cv-ptz-dial-btn-se">
                      <PtzButton icon={<PtzDirectionIcon rotation={135} />} label="SE" title="Pan southeast" disabled={ptzDisabled} onClick={() => void pan(-45)} />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="cv-panel-section cv-rail-section cv-rail-feed-section">
              <div className="cv-panel-header cv-feed-header">
                <span className="cv-feed-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                    <path d="M5 5.4h10" />
                    <path d="M5 10h10" />
                    <path d="M5 14.6h10" />
                    <circle cx="3" cy="5.4" r="0.8" fill="currentColor" stroke="none" />
                    <circle cx="3" cy="10" r="0.8" fill="currentColor" stroke="none" />
                    <circle cx="3" cy="14.6" r="0.8" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span className="cv-feed-header-title">Feed details</span>
                <span className="cv-panel-caption cv-feed-header-caption">feed</span>
              </div>
              <div className="cv-rail-feed-list">
                <RailFeedRow
                  label="Preset"
                  value={presetLabel}
                  detail="Current route"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M3 2h10a1 1 0 0 1 1 1v9.5l-5.5-2L3 14V3a1 1 0 0 1 0 0"/><path d="M3 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1"/></svg>}
                />
                <RailFeedRow
                  label="Stream"
                  value={streamOnline ? "Live" : "Idle"}
                  detail={streamOnline ? "Bridge online" : "Standby"}
                  tone={streamOnline ? "ok" : "neutral"}
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M1.5 6.5a9 9 0 0 1 13 0"/><path d="M4 9a6 6 0 0 1 8 0"/><path d="M6.5 11.5a3 3 0 0 1 3 0"/><circle cx="8" cy="14" r="0.5" fill="currentColor"/></svg>}
                />
                <RailFeedRow
                  label="Frame"
                  value={frameResolution}
                  detail={lastFrameLabel}
                  tone={state.connected ? "ok" : "neutral"}
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M1.5 10.5 5 7l3 3 2.5-2.5 4 4"/><circle cx="5.5" cy="5.5" r="1.2"/></svg>}
                />
                <RailFeedRow
                  label="Detections"
                  value={state.detectionsActive ? "Live" : "Idle"}
                  detail={`${detCountText} / ${lastDetectionLabel}`}
                  tone={state.detectionsActive ? "warn" : "neutral"}
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none"/></svg>}
                />
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

export function createCameraModule(): CockpitModule {
  return {
    id: "camera",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      // Share the existing WebSocket transport (transport.ws.core).
      // DispatchRouter fans out all incoming messages to every dispatcher
      // registered on the same transport, so no transport change is needed.
      const dispatcher = new CameraDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new CameraVisionService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "workspace.camera",
        slot: "workspace",
        label: "Camera",
        render: () => <CameraVisionWorkspaceView runtime={ctx} />
      });
    }
  };
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { CameraDispatcher } from "../dispatcher/impl/CameraDispatcher";
import {
  CameraVisionService,
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

function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "Waiting";
  return new Date(timestampMs).toLocaleTimeString();
}

function formatElapsedMs(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "Waiting";
  if (ageMs < 1000) return `Hace ${Math.round(ageMs)} ms`;
  return `Hace ${(ageMs / 1000).toFixed(1)} s`;
}

function formatElapsedSeconds(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "--";
  const seconds = ageMs / 1000;
  return `${seconds < 1 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
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
      <path d="M12 5v14" />
      <path d="M7.5 10.5 12 5l4.5 5.5" />
    </svg>
  );
}

function PtzZoomIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
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
  icon,
  kind
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "ok" | "warn" | "off";
  icon?: ReactNode;
  kind?: string;
}): JSX.Element {
  return (
    <div className={`cv-rail-feed-row cv-rail-feed-row-${tone}${kind ? ` cv-rail-feed-row-${kind}` : ""}`}>
      {icon ? <span className="cv-rail-feed-icon" aria-hidden="true">{icon}</span> : null}
      <span className="cv-rail-feed-label">{label}</span>
      <strong className="cv-rail-feed-value">{value}</strong>
      {detail ? <span className="cv-rail-feed-detail">{detail}</span> : null}
    </div>
  );
}

const VISION_STREAM_URL = "http://localhost:8089/stream.mjpg";
const SNAP_STALE_MS = 1800;
const STREAM_RECONNECT_STALE_MS = 3000;
const VISION_DATA_URL = "http://localhost:8088/data";
const VISION_DATA_POLL_INTERVAL_MS = 100;
const MIN_DETECTION_CONFIDENCE = 0.35;
const OVERLAY_MIN_CONFIDENCE = 0.50;
const ALERT_HOLD_MS = 500;

type DetectionZone = "left" | "center" | "right";
type RiskLevel = "normal" | "low" | "medium" | "high";
type DetectionTone = "person" | "cone" | "vehicle" | "object";

interface AlertDetection extends Detection {
  zone: DetectionZone;
}

interface CameraAlertState {
  risk: RiskLevel;
  detections: AlertDetection[];
  mainDetection: AlertDetection | null;
  lastJsonMs: number;
  lastDetectionMs: number;
}

const NORMAL_ALERT_STATE: CameraAlertState = {
  risk: "normal",
  detections: [],
  mainDetection: null,
  lastJsonMs: 0,
  lastDetectionMs: 0
};

const RELEVANT_CENTER_LABELS = new Set([
  "person",
  "persona",
  "car",
  "auto",
  "vehicle",
  "vehiculo",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "obstacle",
  "obstaculo"
]);

function parseVisionDataDetections(payload: unknown): Detection[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const camera = root.camera && typeof root.camera === "object" ? root.camera as Record<string, unknown> : {};
  const ai = root.ai && typeof root.ai === "object" ? root.ai as Record<string, unknown> : {};
  const width = Number(camera.width ?? 0);
  const height = Number(camera.height ?? 0);
  const detections = Array.isArray(ai.detections) ? ai.detections : [];
  if (width <= 0 || height <= 0) return [];

  return detections
    .map((raw): Detection | null => {
      if (!raw || typeof raw !== "object") return null;
      const det = raw as Record<string, unknown>;
      const bbox = det.bbox && typeof det.bbox === "object" ? det.bbox as Record<string, unknown> : null;
      if (!bbox) return null;
      const cx = Number(bbox.cx);
      const cy = Number(bbox.cy);
      const boxW = Number(bbox.width);
      const boxH = Number(bbox.height);
      if (![cx, cy, boxW, boxH].every(Number.isFinite) || boxW <= 0 || boxH <= 0) return null;
      const confidence = Math.max(0, Math.min(1, Number(det.score ?? 0)));
      if (confidence < MIN_DETECTION_CONFIDENCE) return null;
      return {
        class: String(det.label || "objeto"),
        confidence,
        bbox: {
          x: Math.max(0, Math.min(1, (cx - boxW / 2) / width)),
          y: Math.max(0, Math.min(1, (cy - boxH / 2) / height)),
          w: Math.max(0, Math.min(1, boxW / width)),
          h: Math.max(0, Math.min(1, boxH / height))
        }
      };
    })
    .filter((det): det is Detection => det !== null);
}

function classifyZone(det: Detection): DetectionZone {
  const centerX = det.bbox.x + det.bbox.w / 2;
  if (centerX < 0.33) return "left";
  if (centerX > 0.66) return "right";
  return "center";
}

function zoneLabel(zone: DetectionZone): string {
  if (zone === "left") return "Izquierda";
  if (zone === "right") return "Derecha";
  return "Centro";
}

function riskLabel(risk: RiskLevel): string {
  if (risk === "high") return "Riesgo alto";
  if (risk === "medium") return "Riesgo medio";
  if (risk === "low") return "Riesgo bajo";
  return "Normal";
}

function detectionDisplayLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "person" || normalized === "persona" || normalized === "pedestrian") return "Persona";
  if (normalized === "cone" || normalized === "cono" || normalized === "traffic cone") return "Cono";
  if (normalized === "car" || normalized === "auto" || normalized === "vehicle" || normalized === "vehiculo") return "Auto";
  if (normalized === "truck" || normalized === "camion") return "Camion";
  if (normalized === "bus") return "Bus";
  if (normalized === "bicycle" || normalized === "bicicleta") return "Bicicleta";
  if (normalized === "motorcycle" || normalized === "moto") return "Moto";
  if (normalized === "obstacle" || normalized === "obstaculo") return "Obstaculo";
  if (!label.trim()) return "Objeto";
  return label.trim().charAt(0).toUpperCase() + label.trim().slice(1);
}

function detectionTone(label: string): DetectionTone {
  const normalized = label.trim().toLowerCase();
  if (normalized === "person" || normalized === "persona" || normalized === "pedestrian") return "person";
  if (normalized === "cone" || normalized === "cono" || normalized === "traffic cone") return "cone";
  if (
    normalized === "car" ||
    normalized === "auto" ||
    normalized === "vehicle" ||
    normalized === "vehiculo" ||
    normalized === "truck" ||
    normalized === "camion" ||
    normalized === "bus" ||
    normalized === "van" ||
    normalized === "bicycle" ||
    normalized === "bicicleta" ||
    normalized === "motorcycle" ||
    normalized === "moto"
  ) {
    return "vehicle";
  }
  return "object";
}

function DetectionIcon({ tone }: { tone: DetectionTone }): JSX.Element {
  if (tone === "cone") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
        <path d="M12 3.5 5.5 18.5h13L12 3.5Z" />
        <path d="M8.5 13h7" />
        <path d="M5 21.5h14" />
      </svg>
    );
  }
  if (tone === "vehicle") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
        <path d="M5 13.5 7.2 8.8A2 2 0 0 1 9 7.6h6a2 2 0 0 1 1.8 1.2l2.2 4.7" />
        <path d="M4.5 13.5h15v4h-15z" />
        <circle cx="7.5" cy="18" r="1.5" />
        <circle cx="16.5" cy="18" r="1.5" />
        <path d="M8 11h8" />
      </svg>
    );
  }
  if (tone === "person") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
        <circle cx="12" cy="7.5" r="4" />
        <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
      <path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8L12 3.5Z" />
      <path d="M12 12 19.2 8" />
      <path d="M12 12v8.2" />
      <path d="M12 12 4.8 8" />
    </svg>
  );
}

function riskTone(risk: RiskLevel): "neutral" | "ok" | "warn" | "off" {
  if (risk === "normal") return "ok";
  if (risk === "high") return "off";
  return "warn";
}

function riskRank(risk: RiskLevel): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function riskForDetection(det: AlertDetection): RiskLevel {
  const label = det.class.trim().toLowerCase();
  if (det.zone === "center" && RELEVANT_CENTER_LABELS.has(label)) return "high";
  if (det.zone === "center") return "medium";
  return "low";
}

function buildAlertState(detections: Detection[], lastJsonMs: number): CameraAlertState {
  const alertDetections = detections
    .map((det): AlertDetection => ({ ...det, zone: classifyZone(det) }))
    .sort((a, b) => {
      const riskDiff = riskRank(riskForDetection(b)) - riskRank(riskForDetection(a));
      return riskDiff !== 0 ? riskDiff : b.confidence - a.confidence;
    });

  if (alertDetections.length === 0) {
    return { ...NORMAL_ALERT_STATE, lastJsonMs };
  }

  const mainDetection = alertDetections[0];
  return {
    risk: riskForDetection(mainDetection),
    detections: alertDetections,
    mainDetection,
    lastJsonMs,
    lastDetectionMs: lastJsonMs
  };
}

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
  const [snapLastFrameMs, setSnapLastFrameMs] = useState<number>(0);
  const lastCameraStampRef = useRef<number>(0);
  const fpsWindowRef = useRef<{ startedMs: number; frames: number }>({ startedMs: Date.now(), frames: 0 });
  const [cameraFps, setCameraFps] = useState<number>(0);
  const [visionDetections, setVisionDetections] = useState<Detection[]>([]);
  const [visionLastDetectionMs, setVisionLastDetectionMs] = useState<number>(0);
  const [alertState, setAlertState] = useState<CameraAlertState>(NORMAL_ALERT_STATE);
  const [ptzExpanded, setPtzExpanded] = useState<boolean>(true);
  const [feedExpanded, setFeedExpanded] = useState<boolean>(true);
  const [detectionsExpanded, setDetectionsExpanded] = useState<boolean>(true);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  useEffect(() => {
    setSnapSrc(`${VISION_STREAM_URL}?_=${Date.now()}`);
    return () => setSnapSrc("");
  }, []);

  useEffect(() => {
    if (snapSrc) return;
    const timer = setTimeout(() => {
      setSnapSrc(`${VISION_STREAM_URL}?_=${Date.now()}`);
    }, 1000);
    return () => clearTimeout(timer);
  }, [snapSrc]);

  // Force stream reconnect when no new frame arrives for STREAM_RECONNECT_STALE_MS.
  // onError covers hard failures; this covers MJPEG streams that silently stop sending.
  useEffect(() => {
    if (!snapSrc || snapLastFrameMs === 0) return;
    const id = setTimeout(() => setSnapSrc(""), STREAM_RECONNECT_STALE_MS);
    return () => clearTimeout(id);
  }, [snapSrc, snapLastFrameMs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollVisionData(): Promise<void> {
      try {
        const response = await fetch(`${VISION_DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`vision data ${response.status}`);
        const payload = await response.json() as unknown;
        if (cancelled) return;
        const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const camera = root.camera && typeof root.camera === "object" ? root.camera as Record<string, unknown> : {};
        const cameraStamp = Number(camera.stamp ?? 0);
        const cameraAgeSec = Number(camera.age_sec ?? Number.NaN);
        const now = Date.now();
        if (Number.isFinite(cameraAgeSec) && cameraAgeSec >= 0) {
          setSnapLastFrameMs(now - cameraAgeSec * 1000);
        } else if (camera.available === true) {
          setSnapLastFrameMs(now);
        }
        if (Number.isFinite(cameraStamp) && cameraStamp > 0 && cameraStamp !== lastCameraStampRef.current) {
          lastCameraStampRef.current = cameraStamp;
          const windowState = fpsWindowRef.current;
          windowState.frames += 1;
          const elapsed = now - windowState.startedMs;
          if (elapsed >= 1000) {
            setCameraFps(Math.round((windowState.frames * 1000) / elapsed));
            fpsWindowRef.current = { startedMs: now, frames: 0 };
          }
        }
        const detections = parseVisionDataDetections(payload);
        setVisionDetections(detections);
        if (detections.length > 0) setVisionLastDetectionMs(now);
        setAlertState((previous) => {
          const next = buildAlertState(detections, now);
          if (next.detections.length > 0) return next;
          if (previous.risk !== "normal" && now - previous.lastDetectionMs <= ALERT_HOLD_MS) {
            return { ...previous, lastJsonMs: now };
          }
          return next;
        });
      } catch {
        if (!cancelled) setVisionDetections([]);
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void pollVisionData(), VISION_DATA_POLL_INTERVAL_MS);
        }
      }
    }

    void pollVisionData();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const nowMs = Date.now();
  const serviceAlertState = state.detectionsActive && state.currentDetections.length > 0
    ? buildAlertState(state.currentDetections, state.lastDetectionMs || Date.now())
    : NORMAL_ALERT_STATE;
  const liveAlertState = alertState.detections.length > 0 || alertState.risk !== "normal"
    ? alertState
    : serviceAlertState;
  const detectionCount = liveAlertState.detections.length;
  const detectionsActive = liveAlertState.risk !== "normal" || detectionCount > 0 || state.detectionsActive;
  const lastDetectionMs = visionLastDetectionMs || state.lastDetectionMs;
  const detCountText = `${detectionCount} obj${detectionCount !== 1 ? "s" : ""}`;
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const streamOnline = navigationState?.cameraStreamConnected === true;
  const snapshotOnline = snapSrc.length > 0 && nowMs - snapLastFrameMs <= SNAP_STALE_MS;
  const feedOnline = state.connected || snapshotOnline;
  const presetLabel = connectionState?.preset === "sim" ? "SIM" : connectionState?.preset === "real" ? "REAL" : "N/A";
  const lastFrameTimestamp = state.lastFrameMs || snapLastFrameMs;
  const frameAgeMs = lastFrameTimestamp > 0 ? Math.max(0, nowMs - lastFrameTimestamp) : null;
  const lastFrameLabel = formatTimestamp(lastFrameTimestamp);
  const lastFrameAgeLabel = formatElapsedSeconds(frameAgeMs);
  const lastFrameAgeDetail = formatElapsedMs(frameAgeMs);
  const lastDetectionLabel = formatTimestamp(lastDetectionMs);
  const jsonTimestampMs = liveAlertState.lastJsonMs || lastDetectionMs;
  const jsonAgeLabel = jsonTimestampMs > 0 ? `${Math.max(0, nowMs - jsonTimestampMs)} ms` : "Waiting";
  const mainDetection = liveAlertState.mainDetection;
  const overviewDetections = liveAlertState.detections;
  const overviewMainDetection = mainDetection ?? overviewDetections[0] ?? null;
  const overviewRisk = liveAlertState.risk;
  const overviewStatusTone = feedOnline ? overviewRisk : "camera-off";
  const overviewStatusLabel = feedOnline ? riskLabel(overviewRisk) : "Desconectado";
  const overviewStatusNormal = feedOnline && overviewRisk === "normal";
  const feedStatusTone: "neutral" | "ok" | "warn" | "off" = !feedOnline
    ? "off"
    : overviewRisk === "normal"
      ? "ok"
      : overviewRisk === "high"
        ? "off"
        : "warn";
  const feedStatusValue = feedOnline ? overviewStatusLabel.toUpperCase() : "DESCONECTADO";
  const feedStatusDetail = !feedOnline ? "Camara offline" : overviewRisk === "normal" ? "Todo OK" : "Riesgo activo";
  const mainObjectLabel = overviewMainDetection ? detectionDisplayLabel(overviewMainDetection.class) : "Ninguno";
  const detectionTypeLabel = overviewMainDetection ? "YOLO + Tracker" : "Ninguno";
  const overviewConfidenceLabel = overviewMainDetection ? `${(overviewMainDetection.confidence * 100).toFixed(0)}%` : "—";
  const zoneText = overviewMainDetection ? zoneLabel(overviewMainDetection.zone) : "—";
  const overviewJsonAgeLabel = jsonAgeLabel;
  const ptzDisabled = !navigationService || !cameraEnabled;
  const fpsLabel = cameraFps > 0 ? `${cameraFps} FPS` : "LIVE";

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
            <div className={`cv-viewport cv-html-viewport cv-alert-${alertState.risk}${!snapSrc ? " cv-viewport--no-signal" : ""}`}>
              {snapSrc ? (
                <img
                  src={snapSrc}
                  className="cv-frame"
                  alt="Camera stream"
                  draggable={false}
                  onLoad={() => setSnapLastFrameMs(Date.now())}
                  onError={() => setSnapSrc("")}
                />
              ) : (
                <div className="cv-no-signal">
                  <div className="cv-no-signal-shell">
                    <div className="cv-no-signal-text">Awaiting camera snapshot</div>
                  </div>
                </div>
              )}
              {snapSrc && overviewDetections.some(d => d.confidence >= OVERLAY_MIN_CONFIDENCE) ? (
                <div className="cv-overlay" aria-hidden="true">
                  {overviewDetections.filter(d => d.confidence >= OVERLAY_MIN_CONFIDENCE).map((det, index) => {
                    const left = `${Math.max(0, Math.min(1, det.bbox.x)) * 100}%`;
                    const top = `${Math.max(0, Math.min(1, det.bbox.y)) * 100}%`;
                    const width = `${Math.max(0, Math.min(1, det.bbox.w)) * 100}%`;
                    const height = `${Math.max(0, Math.min(1, det.bbox.h)) * 100}%`;
                    const label = `${detectionDisplayLabel(det.class)} ${(det.confidence * 100).toFixed(0)}%`;
                    return (
                      <div
                        className="cv-detection-box"
                        key={`${det.class}-${det.confidence}-${index}`}
                        style={{ left, top, width, height }}
                      >
                        <span className="cv-detection-label">{label}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {feedOnline ? <div className="cv-html-rec">● {fpsLabel}</div> : null}
            </div>
          </div>
        </section>

        <aside className="cv-panel cv-html-panel cv-control-rail">
          <div className="cv-panel-scroll cv-control-rail-scroll">
            <section className={`cv-panel-section cv-rail-section cv-rail-detections-section cv-rail-collapsible ${detectionsExpanded ? "cv-rail-collapsible-open" : "cv-rail-collapsible-closed"}`}>
              <button
                className="cv-panel-header cv-detections-header cv-rail-collapsible-header"
                type="button"
                aria-expanded={detectionsExpanded}
                onClick={() => setDetectionsExpanded((open) => !open)}
              >
                <span className="cv-detections-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                    <path d="M4 8V5h3" />
                    <path d="M13 5h3v3" />
                    <path d="M16 12v3h-3" />
                    <path d="M7 15H4v-3" />
                    <circle cx="10" cy="10" r="2" />
                  </svg>
                </span>
                <span>Detecciones</span>
                <span className="cv-panel-caption cv-detections-header-caption">{overviewDetections.length} ACTIVAS</span>
                <span className="cv-rail-collapsible-chevron" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </span>
              </button>
              <div className="cv-detections-panel cv-rail-collapsible-body">
                <div className={`cv-alert-panel cv-alert-panel-${overviewStatusTone} cv-overview-risk-card`}>
                  <div className="cv-overview-risk-head">
                    <span className="cv-overview-risk-icon" aria-hidden="true">
                      {overviewStatusNormal ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                          <circle cx="12" cy="12" r="8.5" />
                          <path d="m8.5 12.4 2.2 2.2 4.8-5.2" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                          <path d="M12 4.5 2.5 20.5h19L12 4.5Z" />
                          <path d="M12 10.5v5" />
                          <circle cx="12" cy="18" r="0.6" fill="currentColor" stroke="none" />
                        </svg>
                      )}
                    </span>
                    <strong>Estado: <span>{overviewStatusLabel}</span></strong>
                    {overviewDetections.length > 0 ? (
                      <span className="cv-overview-active-badge">
                        <span aria-hidden="true" />
                        Deteccion activa
                      </span>
                    ) : null}
                  </div>
                  <div className="cv-overview-risk-lines">
                    <div className="cv-overview-risk-line">
                      <span className="cv-overview-row-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <circle cx="10" cy="6.5" r="3" />
                          <path d="M4 17.5a6 6 0 0 1 12 0" />
                        </svg>
                      </span>
                      <span>Objeto principal</span>
                      <strong>{mainObjectLabel}</strong>
                    </div>
                    <div className="cv-overview-risk-line">
                      <span className="cv-overview-row-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <rect x="5.5" y="5.5" width="9" height="9" rx="2" />
                          <path d="M8 3.5v2" /><path d="M12 3.5v2" />
                          <path d="M8 14.5v2" /><path d="M12 14.5v2" />
                          <path d="M3.5 8h2" /><path d="M3.5 12h2" />
                          <path d="M14.5 8h2" /><path d="M14.5 12h2" />
                        </svg>
                      </span>
                      <span>Tipo de deteccion</span>
                      <strong className="cv-alert-value-truncate" title={detectionTypeLabel}>{detectionTypeLabel}</strong>
                    </div>
                    <div className="cv-overview-risk-line">
                      <span className="cv-overview-row-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <path d="M10 2.5 4 5v4.5c0 4 3.5 6.5 6 7.5 2.5-1 6-3.5 6-7.5V5L10 2.5Z" />
                          <path d="M7.5 10 9 11.5l3.5-3.5" />
                        </svg>
                      </span>
                      <span>Confianza</span>
                      <strong>{overviewConfidenceLabel}</strong>
                    </div>
                    <div className="cv-overview-risk-line">
                      <span className="cv-overview-row-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <path d="M10 1.5a6 6 0 0 1 6 6c0 5.5-6 10.5-6 10.5S4 13 4 7.5a6 6 0 0 1 6-6Z" />
                          <circle cx="10" cy="7.5" r="2.2" />
                        </svg>
                      </span>
                      <span>Zona</span>
                      <strong>{zoneText}</strong>
                    </div>
                    <div className="cv-overview-risk-line">
                      <span className="cv-overview-row-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <circle cx="10" cy="10" r="7.5" />
                          <path d="M10 6v4l2.5 2" />
                        </svg>
                      </span>
                      <span>Ultima actualizacion</span>
                      <strong>{overviewJsonAgeLabel}</strong>
                    </div>
                  </div>
                </div>

                <div className="cv-active-detections-card">
                  <div className="cv-active-detections-head">
                    <strong>Detecciones activas</strong>
                    <span>{overviewDetections.length}</span>
                  </div>
                  <div className="cv-active-detections-list">
                    {overviewDetections.length > 0 ? overviewDetections.map((det, index) => {
                      const percent = Math.round(det.confidence * 100);
                      const tone = detectionTone(det.class);
                      return (
                        <div className={`cv-active-detection cv-active-detection-${tone}`} key={`${det.class}-${det.zone}-${det.confidence}-${index}`}>
                          <span className="cv-active-detection-dot" aria-hidden="true" />
                          <span className="cv-active-detection-icon" aria-hidden="true">
                            <DetectionIcon tone={tone} />
                          </span>
                          <strong>{detectionDisplayLabel(det.class)}</strong>
                          <div className="cv-confidence-meter" aria-label={`Confianza ${percent}%`}>
                            <span style={{ width: `${percent}%` }} />
                          </div>
                          <span className="cv-confidence-value">{percent}%</span>
                          <span className="cv-zone-chip">{zoneLabel(det.zone)}</span>
                        </div>
                      );
                    }) : (
                      <div className="cv-active-detections-empty">
                        Sin detecciones activas
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className={`cv-panel-section cv-rail-section cv-rail-ptz-section cv-rail-collapsible ${ptzExpanded ? "cv-rail-collapsible-open" : "cv-rail-collapsible-closed"}`}>
              <button
                className="cv-panel-header cv-ptz-section-header cv-rail-collapsible-header"
                type="button"
                aria-expanded={ptzExpanded}
                onClick={() => setPtzExpanded((open) => !open)}
              >
                <span className="cv-ptz-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
                    <circle cx="10" cy="10" r="7" />
                    <circle cx="10" cy="10" r="2.5" />
                    <path d="M10 1.5v2" />
                    <path d="M10 16.5v2" />
                    <path d="M1.5 10h2" />
                    <path d="M16.5 10h2" />
                  </svg>
                </span>
                <span>Camera PTZ</span>
                <span className="cv-panel-caption">PAN / ZOOM</span>
                <span className="cv-rail-collapsible-chevron" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </span>
              </button>
              <div className="cv-ptz-panel cv-ptz-panel-compact cv-rail-collapsible-body">
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

            <section className={`cv-panel-section cv-rail-section cv-rail-feed-section cv-rail-collapsible ${feedExpanded ? "cv-rail-collapsible-open" : "cv-rail-collapsible-closed"}`}>
              <button
                className="cv-panel-header cv-feed-header cv-rail-collapsible-header"
                type="button"
                aria-expanded={feedExpanded}
                onClick={() => setFeedExpanded((open) => !open)}
              >
                <span className="cv-feed-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                    <path d="M6.5 5.5h9" />
                    <path d="M6.5 10h9" />
                    <path d="M6.5 14.5h9" />
                    <circle cx="3.5" cy="5.5" r="1" fill="#fff" stroke="none" />
                    <circle cx="3.5" cy="10" r="1" fill="#fff" stroke="none" />
                    <circle cx="3.5" cy="14.5" r="1" fill="#fff" stroke="none" />
                  </svg>
                </span>
                <span className="cv-feed-header-title">Feed details</span>
                <span className="cv-panel-caption cv-feed-header-caption">feed</span>
                <span className="cv-rail-collapsible-chevron" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </span>
              </button>
              <div className="cv-rail-feed-list cv-rail-collapsible-body">
                <RailFeedRow
                  label="Preset"
                  value={presetLabel}
                  detail="Current route"
                  tone={feedOnline ? "ok" : "neutral"}
                  kind="preset"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M3.5 2.5h9v11l-4.5-2.5-4.5 2.5V2.5Z" /></svg>}
                />
                <RailFeedRow
                  label="Stream"
                  value={feedOnline ? "ACTIVO" : "INACTIVO"}
                  detail={feedOnline ? "Online" : "Standby"}
                  tone={feedOnline ? "ok" : "off"}
                  kind="stream"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M1 5.5a9.5 9.5 0 0 1 14 0" /><path d="M3.5 8a6 6 0 0 1 9 0" /><path d="M6 10.5a3 3 0 0 1 4 0" /><circle cx="8" cy="13.5" r="0.8" fill="currentColor" stroke="none" /></svg>}
                />
                <RailFeedRow
                  label="Ultimo frame"
                  value={lastFrameAgeLabel}
                  detail={lastFrameAgeDetail}
                  tone={feedOnline ? "ok" : "neutral"}
                  kind="last-frame"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.4l2.3 1.4" /></svg>}
                />
                <RailFeedRow
                  label="Detecciones"
                  value={`${detectionCount} ${detectionCount === 1 ? "objeto" : "objetos"}`}
                  detail={detectionCount > 0 ? "Actualizadas ahora" : "Sin detecciones"}
                  tone="neutral"
                  kind="detections"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none" /></svg>}
                />
                <RailFeedRow
                  label="Estado"
                  value={feedStatusValue}
                  detail={feedStatusDetail}
                  tone={feedStatusTone}
                  kind="status"
                  icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M8 1.8 3.2 3.7v3.6c0 3.1 2 5.5 4.8 6.9 2.8-1.4 4.8-3.8 4.8-6.9V3.7L8 1.8Z" /><path d="m5.8 8 1.4 1.4 3-3.2" /></svg>}
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

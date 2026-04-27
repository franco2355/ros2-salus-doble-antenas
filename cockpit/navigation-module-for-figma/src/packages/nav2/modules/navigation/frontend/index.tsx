import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./styles.css";
import { PanelCollapsibleSection, PanelSection } from "../../../../core";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { RobotDispatcher } from "../dispatcher/impl/RobotDispatcher";
import { ConnectionService, type ConnectionState } from "../service/impl/ConnectionService";
import { DIALOG_SERVICE_ID, type DialogService } from "../../../../core/modules/runtime/service/impl/DialogService";
import { MapService, type MapWorkspaceState } from "../../map/service/impl/MapService";
import { SensorInfoService, type SensorInfoTab } from "../service/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { NavigationService, type NavigationState, type SnapshotData } from "../service/impl/NavigationService";
import { WebSocketTransport } from "../transport/impl/WebSocketTransport";
import { NavigationCommands } from "../commands";
import { ShellCommands } from "../../../../../app/shellCommands";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const MAP_SERVICE_ID = "service.map";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";

interface Nav2RuntimeConfig {
  ws_real_host?: unknown;
  ws_real_port?: unknown;
  ws_sim_host?: unknown;
  ws_sim_port?: unknown;
  manual_linear_speed_min?: unknown;
  manual_linear_speed_max?: unknown;
  manual_linear_speed_default?: unknown;
  manual_angular_speed_min?: unknown;
  manual_angular_speed_max?: unknown;
  manual_angular_speed_default?: unknown;
  manual_loop_interval_ms?: unknown;
}

interface ManualSpeedLimits {
  linearMin: number;
  linearMax: number;
  angularMin: number;
  angularMax: number;
}

function readNav2Config(ctx: ModuleContext): Nav2RuntimeConfig {
  return ctx.getPackageConfig<Record<string, unknown>>("nav2") as Nav2RuntimeConfig;
}

function parseHost(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : fallback;
}

function parsePort(value: unknown, fallback: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return String(parsed);
}

function parseNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseLoopIntervalMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(20, Math.round(parsed));
}

function parseManualSpeedLimits(config: Nav2RuntimeConfig): ManualSpeedLimits {
  const linearMinCandidate = Number(config.manual_linear_speed_min);
  const linearMaxCandidate = Number(config.manual_linear_speed_max);
  const angularMinCandidate = Number(config.manual_angular_speed_min);
  const angularMaxCandidate = Number(config.manual_angular_speed_max);
  const linearMin = Number.isFinite(linearMinCandidate) ? linearMinCandidate : 1.0;
  const linearMax = Number.isFinite(linearMaxCandidate) ? linearMaxCandidate : 4.0;
  const angularMin = Number.isFinite(angularMinCandidate) ? angularMinCandidate : 0.1;
  const angularMax = Number.isFinite(angularMaxCandidate) ? angularMaxCandidate : 1.2;
  return {
    linearMin: linearMax > linearMin ? linearMin : 1.0,
    linearMax: linearMax > linearMin ? linearMax : 4.0,
    angularMin: angularMax > angularMin ? angularMin : 0.1,
    angularMax: angularMax > angularMin ? angularMax : 1.2
  };
}

function buildConnectionPresetDefaults(ctx: ModuleContext, config: Nav2RuntimeConfig): {
  real: { host: string; port: string };
  sim: { host: string; port: string };
} {
  const wsRealHostFallback = ctx.env.wsRealHost ?? "localhost";
  const wsSimHostFallback = ctx.env.wsSimHost ?? "localhost";
  const wsPortFallback = ctx.env.wsDefaultPort ?? "8766";
  return {
    real: {
      host: parseHost(config.ws_real_host, wsRealHostFallback),
      port: parsePort(config.ws_real_port, wsPortFallback)
    },
    sim: {
      host: parseHost(config.ws_sim_host, wsSimHostFallback),
      port: parsePort(config.ws_sim_port, wsPortFallback)
    }
  };
}

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function getTelemetryService(runtime: ModuleContext): TelemetryServiceLike | null {
  try {
    return runtime.services.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    return null;
  }
}

function formatControlLockReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) return "Robot bloqueado";
  const labels: Record<string, string> = {
    STARTUP_LOCKED: "Robot bloqueado al iniciar",
    UI_LOCK_REQUEST: "Robot bloqueado desde UI",
    UI_HEARTBEAT_TIMEOUT: "Robot bloqueado por heartbeat ausente",
    DISCONNECTED: "Robot bloqueado hasta confirmar backend",
    LOCKED: "Robot bloqueado"
  };
  return labels[normalized] ?? `Robot bloqueado: ${normalized}`;
}

function cleanRouteStatus(status: string): string {
  return status.replace(/\s+\[[^\]]+\]\s*$/u, "").trim().toLowerCase();
}

function formatRouteStatus(status: string): string {
  const normalized = cleanRouteStatus(status);
  if (!normalized || normalized === "idle") return "Idle";
  if (normalized === "route starting") return "Starting route";
  if (normalized.startsWith("route active")) return "Following route";
  if (normalized === "route completed") return "Route complete";
  if (normalized === "route cancelled") return "Route cancelled";
  if (normalized === "route paused by manual takeover") return "Paused by manual";
  if (normalized.startsWith("route failed")) return "Route error";
  return status.trim();
}

function routeTone(routeMission: NavigationState["routeMission"]): "active" | "paused" | "done" | "error" | "idle" {
  const status = cleanRouteStatus(routeMission.status);
  if (routeMission.paused || status.includes("paused")) return "paused";
  if (status.includes("failed") || status.includes("abort")) return "error";
  if (status.includes("completed")) return "done";
  if (status.includes("cancelled")) return "idle";
  if (routeMission.active || status.includes("active") || status.includes("starting")) return "active";
  return "idle";
}

function buildNavigationStatus(
  state: NavigationState,
  telemetry: TelemetrySnapshot | null
): {
  title: string;
  detail: string;
  tone: "active" | "paused" | "done" | "error" | "idle" | "manual";
  progressPct: number;
  showProgress: boolean;
  segmentText: string;
  routeMetaText: string;
} {
  const routeMission = state.routeMission;
  const tone = routeTone(routeMission);
  const expandedCount = Math.max(0, Math.round(routeMission.expandedWaypointCount));
  const status = cleanRouteStatus(routeMission.status);
  const startIndex = Math.max(0, Math.round(routeMission.currentStartIndex));
  const routeProgressCount =
    expandedCount > 0
      ? status.includes("completed")
        ? expandedCount
        : Math.min(expandedCount, startIndex)
      : 0;
  const progressPct = expandedCount > 0 ? Math.min(100, Math.max(0, (routeProgressCount / expandedCount) * 100)) : 0;
  const hasRouteHistory =
    expandedCount > 0 || routeMission.inputWaypointCount > 0 || cleanRouteStatus(routeMission.status) !== "idle";
  const routeMetaText =
    expandedCount > 0
      ? `${routeProgressCount}/${expandedCount} route points${routeMission.loop ? " · loop" : ""}`
      : routeMission.loop
        ? "Loop route"
        : "";
  const segmentText =
    routeMission.activeChunkSize > 0
      ? `Segment ${routeMission.currentStartIndex + 1}-${routeMission.currentTargetIndex + 1} · ${routeMission.activeChunkSize} pts`
      : routeMission.currentTargetIndex > 0
        ? `Last segment ${routeMission.currentStartIndex + 1}-${routeMission.currentTargetIndex + 1}`
        : "";

  if (state.manualMode || state.manualDisablePending) {
    return {
      title: state.manualDisablePending ? "Leaving manual control" : "Manual control",
      detail: routeMission.paused ? "Route paused" : "Operator control",
      tone: "manual",
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (tone !== "idle" || hasRouteHistory) {
    return {
      title: tone === "paused" ? "Route paused" : formatRouteStatus(routeMission.status),
      detail: routeMission.loop ? "Mission loop enabled" : tone === "done" ? "Final brake expected" : "Route mission",
      tone,
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (telemetry?.goalActive) {
    return {
      title: state.loopRoute ? "Loop goal active" : "Goal active",
      detail: "Send navigation",
      tone: "active",
      progressPct: 0,
      showProgress: false,
      segmentText: "",
      routeMetaText: ""
    };
  }

  const lastResult = String(telemetry?.navResultText ?? state.lastStatus ?? "").trim();
  return {
    title: lastResult && lastResult !== "idle" ? formatRouteStatus(lastResult) : "Ready",
    detail: "No active navigation",
    tone: "idle",
    progressPct: 0,
    showProgress: false,
    segmentText: "",
    routeMetaText: ""
  };
}

function formatRecordingSummary(state: NavigationState): string {
  const bits = [`Recorder: ${state.recording.active ? "recording" : "idle"}`, `count=${state.recording.count}`];
  if (!state.recording.active && state.recording.lastMessage) {
    bits.push(state.recording.lastMessage);
  }
  return bits.join(" · ");
}

function formatPatrolSummary(state: NavigationState): string {
  const currentDisplay = state.patrolLoop.currentWaypoint >= 0 ? state.patrolLoop.currentWaypoint + 1 : "-";
  const totalDisplay = state.patrolLoop.totalWaypoints > 0 ? state.patrolLoop.totalWaypoints : 0;
  const labelSuffix = state.patrolLoop.label ? ` · ${state.patrolLoop.label}` : "";
  return `Patrol: ${state.patrolLoop.active ? "active" : "idle"} · wp=${currentDisplay}/${totalDisplay}${labelSuffix}`;
}

function getMapService(runtime: ModuleContext): MapService | null {
  try {
    return runtime.services.getService<MapService>(MAP_SERVICE_ID);
  } catch {
    return null;
  }
}

function formatInfoNumber(value: unknown, digits = 2): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(digits);
}

function formatInfoCoordinate(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(6);
}

function formatInfoTimestamp(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "n/a";
  return new Date(numeric).toLocaleString();
}

function joinClassNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type NavGlyphKind =
  | "connect"
  | "disconnect"
  | "goal"
  | "manual"
  | "undo"
  | "clear"
  | "remove"
  | "dispatch"
  | "route"
  | "cancel"
  | "save"
  | "load"
  | "snapshot"
  | "recordStart"
  | "recordStop"
  | "recordClear"
  | "patrolStart"
  | "patrolStop";

function NavGlyph({ kind }: { kind: NavGlyphKind }): JSX.Element {
  const baseProps = {
    viewBox: "0 0 24 24",
    width: 15,
    height: 15,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  switch (kind) {
    case "connect":
      return (
        <svg {...baseProps}>
          <path d="M8 8V4" />
          <path d="M16 8V4" />
          <path d="M7 12h10" />
          <path d="M9 12v2a3 3 0 0 0 6 0v-2" />
          <path d="M12 17v3" />
        </svg>
      );
    case "disconnect":
      return (
        <svg {...baseProps}>
          <path d="M8 8V4" />
          <path d="M16 8V4" />
          <path d="M7 12h10" />
          <path d="M9 12v2a3 3 0 0 0 6 0v-2" />
          <path d="M5 19 19 5" />
        </svg>
      );
    case "goal":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="6.5" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 3v2.5" />
        </svg>
      );
    case "manual":
      return (
        <svg {...baseProps}>
          <path d="M12 4v5" />
          <path d="M12 15v5" />
          <path d="M4 12h5" />
          <path d="M15 12h5" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case "undo":
      return (
        <svg {...baseProps}>
          <path d="M9 8 5 12l4 4" />
          <path d="M6 12h7a5 5 0 1 1 0 10" />
        </svg>
      );
    case "clear":
      return (
        <svg {...baseProps}>
          <path d="M4 7h16" />
          <path d="M9 7V5.5h6V7" />
          <path d="m7 7 1 11h8l1-11" />
        </svg>
      );
    case "remove":
      return (
        <svg {...baseProps}>
          <path d="M7 7l10 10" />
          <path d="M17 7 7 17" />
        </svg>
      );
    case "dispatch":
      return (
        <svg {...baseProps}>
          <path d="M5 12h12" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      );
    case "route":
      return (
        <svg {...baseProps}>
          <circle cx="6" cy="17" r="1.8" />
          <circle cx="12" cy="7" r="1.8" />
          <circle cx="18" cy="13" r="1.8" />
          <path d="M7.5 15.8 10.5 8.4" />
          <path d="m13.5 8.2 3 3.6" />
        </svg>
      );
    case "cancel":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="7" />
          <path d="M9 9l6 6" />
          <path d="M15 9 9 15" />
        </svg>
      );
    case "save":
      return (
        <svg {...baseProps}>
          <path d="M12 4v10" />
          <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
          <path d="M5 17.5h14v2H5z" />
        </svg>
      );
    case "load":
      return (
        <svg {...baseProps}>
          <path d="M12 20V10" />
          <path d="m8.5 13.5 3.5-3.5 3.5 3.5" />
          <path d="M5 4.5h14v2H5z" />
        </svg>
      );
    case "snapshot":
      return (
        <svg {...baseProps}>
          <rect x="4" y="7" width="16" height="10" rx="2.5" />
          <circle cx="12" cy="12" r="3" />
          <path d="M8 7 9.5 5.5h5L16 7" />
        </svg>
      );
    case "recordStart":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="5.2" />
        </svg>
      );
    case "recordStop":
      return (
        <svg {...baseProps}>
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        </svg>
      );
    case "recordClear":
      return (
        <svg {...baseProps}>
          <path d="M5 16 11 8l4 4-6 8H5z" />
          <path d="M13 6 18 11" />
        </svg>
      );
    case "patrolStart":
      return (
        <svg {...baseProps}>
          <path d="m9 7 7 5-7 5z" />
          <path d="M5 6v12" opacity="0.45" />
        </svg>
      );
    case "patrolStop":
      return (
        <svg {...baseProps}>
          <path d="M8 7v10" />
          <path d="M16 7v10" />
        </svg>
      );
  }
}

function ButtonFace({
  icon,
  label,
  meta,
  compact = false
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  compact?: boolean;
}): JSX.Element {
  return (
    <span className={joinClassNames("button-face bf", compact && "button-face-compact")}>
      <span className="button-face-icon bf-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="button-face-copy bf-copy">
        <span className="button-face-label bf-label">{label}</span>
        {meta ? <span className="button-face-meta bf-meta">{meta}</span> : null}
      </span>
    </span>
  );
}

function NavSidebarCollapsibleSection({
  title,
  className,
  defaultCollapsed = false,
  children
}: {
  title: string;
  className?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();

  return (
    <section className={joinClassNames("ps", "nav-sidebar-collapsible-section", collapsed && "collapsed", className)}>
      <button
        type="button"
        className="nav-sidebar-section-header"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed((current) => !current)}
      >
        <span className="ps-title">{title}</span>
        <span className="nav-sidebar-section-chevron" aria-hidden="true" />
      </button>
      <div id={bodyId} className="nav-sidebar-section-body" aria-hidden={collapsed}>
        <div className="nav-sidebar-section-content">{children}</div>
      </div>
    </section>
  );
}

function ConnectionSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <PanelSection title="Connection">
        <div className="stack">
          <select
            className="connection-preset-select"
            value={state.preset}
            onChange={(event) => service.setPreset(event.target.value === "sim" ? "sim" : "real")}
          >
            <option value="real">Real</option>
            <option value="sim">Sim</option>
          </select>
          <div className="input-grid">
            <input value={state.host} onChange={(event) => service.setHost(event.target.value)} placeholder="Host" />
            <input value={state.port} onChange={(event) => service.setPort(event.target.value)} placeholder="Port" />
          </div>
          <div className="action-grid">
            <button
              type="button"
              className="button-primary button-tile"
              disabled={state.connecting}
              onClick={async () => {
                try {
                  await service.connect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              <ButtonFace
                icon={<NavGlyph kind="connect" />}
                label={state.connecting ? "Connecting" : "Connect"}
                meta={state.connecting ? "Opening backend session" : "Open backend session"}
              />
            </button>
            <button
              type="button"
              className="button-secondary button-tile"
              onClick={async () => {
                try {
                  await service.disconnect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              <ButtonFace icon={<NavGlyph kind="disconnect" />} label="Disconnect" meta="Close current session" />
            </button>
          </div>
          {state.lastError ? <p className="muted">Error: {state.lastError}</p> : null}
        </div>
      </PanelSection>
    </div>
  );
}

function ConnectionStatusFooterItem({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <span className={`connection-footer-status-badge ${state.connected ? "connected" : "disconnected"}`}>
      {state.connected ? "Conectado" : "Desconectado"}
    </span>
  );
}

function NavigationSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const navService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const connService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const telemetryService = getTelemetryService(runtime);
  const [navState, setNavState] = useState<NavigationState>(navService.getState());
  const [connState, setConnState] = useState(connService.getState());
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const wps = navState.waypoints.length;
  const selectedCount = navState.selectedWaypointIndexes.length;
  const lockReasonText = formatControlLockReason(navState.controlLockReason);
  const routeMission = navState.routeMission;
  const missionActive = routeMission.active || routeMission.paused || (telemetrySnapshot?.goalActive === true);
  const patrolling = navState.patrolLoop.active;

  useEffect(() => navService.subscribe((next) => setNavState(next)), [navService]);
  useEffect(() => connService.subscribe((next) => setConnState(next)), [connService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", { level: "info", text, timestamp: Date.now() });
  };
  const emitError = (text: string): void => {
    runtime.eventBus.emit("console.event", { level: "error", text, timestamp: Date.now() });
  };

  return (
    <div className="nav-sidebar">

      {/* ── 1. CONNECTION ─────────────────────────────────────────────── */}
      <div className="ps">
        <div className="ps-title">CONNECTION</div>
        <select
          className="connection-preset-select"
          value={connState.preset}
          onChange={(event) => connService.setPreset(event.target.value === "sim" ? "sim" : "real")}
        >
          <option value="real">Real</option>
          <option value="sim">Sim</option>
        </select>
        <div className="input-grid">
          <input
            value={connState.host}
            onChange={(event) => connService.setHost(event.target.value)}
            placeholder="192.168.1.100"
          />
          <input
            value={connState.port}
            onChange={(event) => connService.setPort(event.target.value)}
            placeholder="9090"
          />
        </div>
        <div className="action-grid">
          <button
            type="button"
            className="bt prim-btn"
            disabled={connState.connecting}
            onClick={async () => {
              try {
                await connService.connect();
              } catch {
                // error persisted in connState.lastError
              }
            }}
          >
            <ButtonFace
              icon={<NavGlyph kind="connect" />}
              label={connState.connecting ? "CONNECTING" : "CONNECT"}
              meta="Open backend session"
            />
          </button>
          <button
            type="button"
            className="bt sec-btn"
            onClick={async () => {
              try {
                await connService.disconnect();
              } catch {
                // error persisted in connState.lastError
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="disconnect" />} label="DISCONNECT" meta="Close session" />
          </button>
        </div>
        {!connState.connected && (
          <p className="ps-status-error">
            {connState.lastError ? `Error: ${connState.lastError}` : "Desconectado"}
          </p>
        )}
      </div>

      {/* ── 2. CONTROL MODE ───────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection title="CONTROL MODE" className="nav-sidebar-control-section">
        <div className="ncb-grid">
          <button
            type="button"
            className={joinClassNames("ncb", navState.goalMode && "active")}
            title={navState.controlLocked ? lockReasonText : "Goal mode"}
            disabled={navState.controlLocked}
            onClick={() => {
              const enabled = navService.toggleGoalMode();
              emitInfo(enabled ? "Goal mode enabled" : "Goal mode disabled");
            }}
          >
            <ButtonFace icon={<NavGlyph kind="goal" />} label="GOAL MODE" meta={navState.goalMode ? "Enabled" : "Standby"} compact />
          </button>
          <button
            type="button"
            className={joinClassNames("ncb", navState.manualMode && "active")}
            title={navState.controlLocked ? lockReasonText : "Manual mode"}
            disabled={navState.controlLocked}
            onClick={async () => {
              const next = !navState.manualMode;
              try {
                await navService.setManualMode(next);
                emitInfo(next ? "Manual mode enabled" : "Manual mode disabled");
              } catch (error) {
                emitError(`Manual mode failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="manual" />} label="MANUAL" meta={navState.manualMode ? "Enabled" : "Disabled"} compact />
          </button>
        </div>
        <label className="check-row nav-loop-check">
          <input
            type="checkbox"
            checked={navState.loopRoute}
            onChange={(event) => navService.setLoopRoute(event.target.checked)}
          />
          Loop route
        </label>
      </NavSidebarCollapsibleSection>

      {/* ── 3. WAYPOINTS ──────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection
        title="WAYPOINTS"
        className="nav-sidebar-compact-section nav-sidebar-waypoints-section"
      >
        <div className="ncb-3-grid nav-sidebar-compact-grid">
          <button
            type="button"
            className="ncb sec-btn"
            disabled={wps === 0}
            title="Deshacer último waypoint"
            onClick={() => {
              navService.removeLastWaypoint();
              emitInfo("Last waypoint removed");
            }}
          >
            <ButtonFace icon={<NavGlyph kind="undo" />} label="UNDO" meta="Last waypoint" compact />
          </button>
          <button
            type="button"
            className="ncb danger-btn"
            disabled={wps === 0}
            title="Limpiar todos los waypoints"
            onClick={() => {
              navService.clearWaypoints();
              emitInfo("Waypoints cleared");
            }}
          >
            <ButtonFace icon={<NavGlyph kind="clear" />} label="CLEAR" meta="All waypoints" compact />
          </button>
          <button
            type="button"
            className="ncb danger-btn"
            disabled={selectedCount === 0}
            title={`${selectedCount} waypoints seleccionados`}
            onClick={() => {
              const removed = navService.removeSelectedWaypoints();
              if (removed > 0) emitInfo(`Removed ${removed} selected waypoint${removed > 1 ? "s" : ""}`);
            }}
          >
            <ButtonFace icon={<NavGlyph kind="remove" />} label="REMOVE" meta={`${selectedCount} sel.`} compact />
          </button>
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 4. DISPATCH ───────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection title="NAVIGATION ACTIONS" className="nav-sidebar-actions-section">
        <button
          type="button"
          className="ncb-wide send-btn"
          disabled={wps === 0}
          onClick={async () => {
            try {
              const sent = await navService.sendQueuedGoal();
              emitInfo(`Goal dispatch sent (${sent.sentCount} waypoint${sent.sentCount > 1 ? "s" : ""})`);
            } catch (error) {
              emitError(`Goal failed: ${String(error)}`);
            }
          }}
        >
          <ButtonFace icon={<NavGlyph kind="dispatch" />} label="DISPATCH GOAL" meta={`${wps} waypoints queued`} />
        </button>
        <button
          type="button"
          className="ncb-wide send-btn"
          disabled={wps < 2}
          onClick={async () => {
            try {
              const started = await navService.sendRouteMission();
              emitInfo(`Route mission started (${started.inputCount} wps, ${started.expandedCount} pts)`);
            } catch (error) {
              emitError(`Route mission failed: ${String(error)}`);
            }
          }}
        >
          <ButtonFace icon={<NavGlyph kind="route" />} label="ROUTE MISSION" meta="Expand and execute route" />
        </button>
        <button
          type="button"
          className="ncb-wide cancel-btn"
          disabled={!missionActive}
          onClick={async () => {
            try {
              if (routeMission.active || routeMission.paused) {
                await navService.cancelRouteMission();
                emitInfo("Route mission cancelled");
              } else {
                await navService.cancelGoal();
                emitInfo("Goal cancelled");
              }
            } catch (error) {
              emitError(`Cancel failed: ${String(error)}`);
            }
          }}
        >
          <ButtonFace icon={<NavGlyph kind="cancel" />} label="CANCEL" meta="Stop active navigation" />
        </button>
      </NavSidebarCollapsibleSection>

      {/* ── 5. FILE ───────────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection
        title="FILE"
        className="nav-sidebar-compact-section nav-sidebar-file-section"
      >
        <div className="ncb-3-grid nav-sidebar-compact-grid">
          <button
            type="button"
            className="ncb sec-btn"
            title="Guardar ruta"
            onClick={async () => {
              try {
                const count = await navService.saveWaypointsFile();
                emitInfo(`Saved ${count} waypoints`);
              } catch (error) {
                emitError(`Save waypoints failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="save" />} label="SAVE" meta="Persist waypoints" compact />
          </button>
          <button
            type="button"
            className="ncb sec-btn"
            title="Cargar ruta"
            onClick={async () => {
              try {
                const count = await navService.loadWaypointsFile();
                emitInfo(`Loaded ${count} waypoints`);
              } catch (error) {
                emitError(`Load waypoints failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="load" />} label="LOAD" meta="Restore saved" compact />
          </button>
          <button
            type="button"
            className="ncb sec-btn"
            title="Snapshot"
            onClick={() => {
              void runtime.commands.execute(NavigationCommands.openSnapshotModal);
            }}
          >
            <ButtonFace icon={<NavGlyph kind="snapshot" />} label="SNAPSHOT" meta="Capture state" compact />
          </button>
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 6. RECORDING ──────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection title="RECORDING" className="nav-sidebar-recording-section">
        <div className="ncb-3-grid">
          <button
            type="button"
            className={joinClassNames("ncb sec-btn", navState.recording.active && "active")}
            title="Iniciar grabación"
            onClick={async () => {
              try {
                await navService.startRecording();
                emitInfo("Waypoint recording started");
              } catch (error) {
                emitError(`Start recording failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="recordStart" />} label="START" meta="Sample" compact />
          </button>
          <button
            type="button"
            className="ncb danger-btn"
            disabled={!navState.recording.active}
            title="Detener y guardar"
            onClick={async () => {
              try {
                await navService.stopRecording();
                emitInfo("Waypoint recording stopped");
              } catch (error) {
                emitError(`Stop recording failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="recordStop" />} label="STOP" meta="Save" compact />
          </button>
          <button
            type="button"
            className="ncb sec-btn"
            disabled={navState.recording.active}
            title="Limpiar sesión grabada"
            onClick={async () => {
              try {
                await navService.clearRecording();
                emitInfo("Waypoint recording cleared");
              } catch (error) {
                emitError(`Clear recording failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="recordClear" />} label="CLEAR" meta="Reset" compact />
          </button>
        </div>
        <div className="ps-rec-status">
          <span
            className={joinClassNames("ps-rec-dot", navState.recording.active && "recording")}
            aria-hidden="true"
          />
          {navState.recording.active
            ? `Recording · count=${navState.recording.count}`
            : `Idle · count=${navState.recording.count}`}
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 7. PATROL ─────────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection title="PATROL" className="nav-sidebar-patrol-section">
        <div className="ncb-grid">
          <button
            type="button"
            className="ncb send-btn"
            disabled={wps === 0 || patrolling}
            title="Iniciar patrulla"
            onClick={async () => {
              try {
                await navService.startPatrol();
                emitInfo("Loop patrol started");
              } catch (error) {
                emitError(`Start patrol failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="patrolStart" />} label="START" meta="Loop route" />
          </button>
          <button
            type="button"
            className="ncb cancel-btn"
            disabled={!patrolling}
            title="Detener patrulla"
            onClick={async () => {
              try {
                await navService.stopPatrol();
                emitInfo("Loop patrol stopped");
              } catch (error) {
                emitError(`Stop patrol failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="patrolStop" />} label="STOP" meta="Hold patrol" />
          </button>
        </div>
        <div className={`status-pill nav-route-status ${patrolling ? "ok" : ""}`.trim()}>
          {formatPatrolSummary(navState)}
        </div>
      </NavSidebarCollapsibleSection>

      {/* Speed limits + Zones (existing sub-components) */}
    </div>
  );
}

function ManualControlSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [state, setState] = useState<NavigationState>(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <PanelSection title="Speed limits">
        <label className="range-row">
          Linear speed (m/s): {state.manualLinearSpeed.toFixed(2)}
          <input
            type="range"
            min={state.manualLinearMin}
            max={state.manualLinearMax}
            step={0.01}
            value={state.manualLinearSpeed}
            onChange={(event) => service.setManualLinearSpeed(Number(event.target.value))}
          />
        </label>
        <label className="range-row">
          Angular speed (rad/s): {state.manualAngularSpeed.toFixed(2)}
          <input
            type="range"
            min={state.manualAngularMin}
            max={state.manualAngularMax}
            step={0.01}
            value={state.manualAngularSpeed}
            onChange={(event) => service.setManualAngularSpeed(Number(event.target.value))}
          />
        </label>
      </PanelSection>
    </div>
  );
}

function ZonesSidebarSection({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const mapService = getMapService(runtime);
  const dialogService = runtime.services.getService<DialogService>(DIALOG_SERVICE_ID);
  const [state, setState] = useState<MapWorkspaceState | null>(mapService ? mapService.getState() : null);

  useEffect(() => {
    if (!mapService) return;
    return mapService.subscribe((next) => setState(next));
  }, [mapService]);

  if (!mapService || !state) return null;

  return (
    <div className="stack">
      <PanelCollapsibleSection title="Zones">
        <div className="zones-legacy-grid">
          <button
            type="button"
            className="button-tile button-secondary"
            onClick={async () => {
              try {
                await mapService.loadMap("map");
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Zones refreshed",
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Refresh zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            <ButtonFace icon="↻" label="Refresh" meta="Fetch latest zones" compact />
          </button>
          <button
            type="button"
            className="danger-btn button-tile"
            onClick={async () => {
              const ok = await dialogService.confirm({
                title: "Clear zones",
                message: `Clear all ${state.zones.length} no-go zones?`,
                confirmLabel: "Clear",
                cancelLabel: "Cancel",
                danger: true
              });
              if (!ok) return;
              mapService.clearZones();
              runtime.eventBus.emit("console.event", {
                level: "warn",
                text: "Zones cleared",
                timestamp: Date.now()
              });
            }}
          >
            <ButtonFace icon="✕" label="Clear" meta="Remove all zones" compact />
          </button>
          <button
            type="button"
            className="button-primary button-tile"
            onClick={async () => {
              try {
                await mapService.pushZonesToBackend();
                const count = mapService.persistZonesToStorage();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones saved (${count})`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Save zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            <ButtonFace icon="⬆" label="Save" meta="Push and persist" compact />
          </button>
          <button
            type="button"
            className="button-secondary button-tile"
            onClick={async () => {
              try {
                const count = mapService.loadZonesFromStorage();
                await mapService.loadZonesFromBackend();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones loaded (${count})`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Load zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            <ButtonFace icon="⬇" label="Load" meta="Restore saved zones" compact />
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={state.autoSync} onChange={(event) => mapService.setAutoSync(event.target.checked)} />
          Auto-sync edits
        </label>
      </PanelCollapsibleSection>
      <PanelCollapsibleSection title="Zone List">
        {state.zones.length === 0 ? (
          <p className="muted">No zones.</p>
        ) : (
          <ul className="zone-list">
            {state.zones.map((zone) => (
              <li key={zone.id} className="zone-item">
                <div>
                  <strong>{zone.name}</strong>
                  <div className="muted">
                    vertices={zone.vertices} · {new Date(zone.updatedAt).toLocaleTimeString()}
                  </div>
                </div>
                <button type="button" className="danger-btn" onClick={() => mapService.removeZone(zone.id)}>
                  <ButtonFace icon="−" label="Remove" meta="Delete zone" compact />
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelCollapsibleSection>
    </div>
  );
}

function snapshotExtFromMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

function isCameraDisabledPresetError(text: string): boolean {
  return text.toLowerCase().includes("camera disabled in current preset");
}

function SnapshotModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [navigation, setNavigation] = useState<NavigationState>(service.getState());
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(service.getState().lastSnapshot);
  const [loading, setLoading] = useState(false);

  useEffect(() => service.subscribe((next) => setNavigation(next)), [service]);
  useEffect(() => {
    setSnapshot(navigation.lastSnapshot);
  }, [navigation.lastSnapshot]);

  const captureSnapshot = async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await service.requestSnapshot();
      setSnapshot(next);
    } catch (error) {
      const message = String(error);
      if (isCameraDisabledPresetError(message)) {
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: "Snapshot no disponible para el preset de conexión actual.",
          timestamp: Date.now()
        });
        return;
      }
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Snapshot capture failed: ${message}`,
        timestamp: Date.now()
      });
    } finally {
      setLoading(false);
    }
  };

  const download = (): void => {
    const snapshotToDownload = snapshot ?? service.getState().lastSnapshot;
    if (!snapshotToDownload || typeof window === "undefined") return;
    const mime = snapshotToDownload.mime || "image/png";
    const ext = snapshotExtFromMime(mime);
    try {
      const link = window.document.createElement("a");
      link.href = `data:${mime};base64,${snapshotToDownload.imageBase64}`;
      link.download = `nav_snapshot_${snapshotToDownload.stamp}.${ext}`;
      link.click();
      runtime.eventBus.emit(NAV_EVENTS.snapshotDownloadResult, {
        ok: true,
        text: "Captura descargada correctamente."
      });
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Snapshot download failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  useEffect(() => {
    const unsubscribeCapture = runtime.eventBus.on(NAV_EVENTS.snapshotCaptureRequest, () => {
      void captureSnapshot();
    });
    const unsubscribeDownload = runtime.eventBus.on(NAV_EVENTS.snapshotDownloadRequest, () => {
      download();
    });
    return () => {
      unsubscribeCapture();
      unsubscribeDownload();
    };
  }, [runtime.eventBus, service]);

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            void captureSnapshot();
          }}
        >
          {loading ? "Loading..." : "Capture snapshot"}
        </button>
        <button type="button" disabled={!snapshot} onClick={download}>
          Download
        </button>
      </div>
      {snapshot?.imageBase64 ? (
        <img
          className="snapshot-image"
          src={`data:${snapshot.mime};base64,${snapshot.imageBase64}`}
          alt="Navigation snapshot"
        />
      ) : (
        <div className="modal-preview">Snapshot preview area</div>
      )}
      <p className="muted">Esc: close · Shift+Esc: download + close</p>
    </div>
  );
}

function SnapshotModalFooter({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [message, setMessage] = useState("");
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = runtime.eventBus.on<{ ok?: unknown; text?: unknown }>(NAV_EVENTS.snapshotDownloadResult, (event) => {
      if (event.ok !== true) return;
      const text =
        typeof event.text === "string" && event.text.trim().length > 0
          ? event.text.trim()
          : "Captura descargada correctamente.";
      setMessage(text);
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = window.setTimeout(() => {
        setMessage("");
      }, 5000);
    });

    return () => {
      unsubscribe();
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [runtime.eventBus]);

  return (
    <div className="snapshot-modal-footer">
      {message ? <span className="snapshot-modal-footer-status">{message}</span> : null}
    </div>
  );
}

function InfoModalFooter({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  const [state, setState] = useState(sensorInfoService.getState());

  useEffect(() => sensorInfoService.subscribe((next) => setState(next)), [sensorInfoService]);

  const activeInterval = state.intervals[state.activeTab];
  const activeLoading = state.loading[state.activeTab];

  return (
    <div className="modal-footer-split">
      <div className="modal-footer-left">{activeLoading ? <span className="modal-footer-loading">Loading...</span> : null}</div>
      <div className="modal-footer-right">
        <label className="modal-footer-refresh">
          <span>Refresh (s)</span>
          <input
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={activeInterval.toFixed(1)}
            onChange={(event) => {
              void sensorInfoService.setInterval(state.activeTab, Number(event.target.value));
            }}
          />
        </label>
      </div>
    </div>
  );
}

function InfoModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const telemetryService = getTelemetryService(runtime);
  const sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [state, setState] = useState(sensorInfoService.getState());
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );

  useEffect(() => sensorInfoService.subscribe((next) => setState(next)), [sensorInfoService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetry(next));
  }, [telemetryService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  useEffect(() => {
    void sensorInfoService.open();
    return () => {
      void sensorInfoService.close();
    };
  }, [sensorInfoService]);

  const changeTab = (tab: SensorInfoTab): void => {
    void sensorInfoService.setActiveTab(tab);
  };

  const activePayload = state.payloads[state.activeTab] as Record<string, unknown> | undefined;
  const activeSnapshot = (activePayload?.snapshot ?? {}) as Record<string, unknown>;
  const activeError = state.errors[state.activeTab];
  const topicRows = state.topics.catalog.filter((entry) =>
    entry.name.toLowerCase().includes(state.topics.search.trim().toLowerCase())
  );
  const selectedTopicMeta = state.topics.catalog.find((entry) => entry.name === state.topics.selectedTopic) ?? null;
  const topicsPayload = state.payloads.topics as Record<string, unknown> | undefined;
  const topicsSnapshot = (topicsPayload?.snapshot ?? {}) as Record<string, unknown>;
  const topicsSnapshotError = String(topicsSnapshot.error ?? "").trim();
  const connected = connectionState ? connectionState.connected : true;
  const showDisconnected = !connected && state.implemented[state.activeTab];

  return (
    <div className="stack info-modal-root">
      <div className="modal-tabs">
        {(["general", "topics", "pixhawk_gps", "lidar", "camera"] as SensorInfoTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`modal-tab ${state.activeTab === tab ? "active" : ""}`}
            onClick={() => changeTab(tab)}
          >
            {tab === "pixhawk_gps" ? "Pixhawk/GPS" : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {activeError ? <div className="status-pill bad">Error: {activeError}</div> : null}
      {showDisconnected ? (
        <div className="panel-card info-placeholder-card">
          <strong>{state.activeTab === "pixhawk_gps" ? "Pixhawk/GPS" : state.activeTab[0].toUpperCase() + state.activeTab.slice(1)}</strong>
          <p className="muted">Conecta el WebSocket para consultar informacion de sensores.</p>
        </div>
      ) : null}
      {!showDisconnected && state.loading[state.activeTab] && !activePayload ? (
        <div className="panel-card info-placeholder-card">
          <strong>Cargando...</strong>
          <p className="muted">Esperando datos del backend.</p>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "general" ? (
        <div className="info-card-grid">
          <div className="panel-card">
            <h4>General</h4>
            <div className="key-value-grid">
              <span>Robot mode</span>
              <span>{telemetry?.robotStatus.mode ?? "unknown"}</span>
              <span>Battery</span>
              <span>{telemetry ? `${Number(telemetry.robotStatus.batteryPct).toFixed(1)}%` : "n/a"}</span>
              <span>GPS fix</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.fix_type_name ?? "UNKNOWN")}</span>
              <span>Precision</span>
              <span>{formatInfoNumber((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.estimated_precision_m, 2)} m</span>
              <span>RTK source</span>
              <span>
                {String(
                  (activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_label ??
                    (activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_id ??
                    "n/a"
                )}
              </span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Datum</h4>
            <div className="key-value-grid">
              <span>Status</span>
              <span>{(activeSnapshot.datum as Record<string, unknown> | undefined)?.already_set === true ? "set" : "unset"}</span>
              <span>Latitude</span>
              <span>{formatInfoCoordinate((activeSnapshot.datum as Record<string, unknown> | undefined)?.datum_lat)}</span>
              <span>Longitude</span>
              <span>{formatInfoCoordinate((activeSnapshot.datum as Record<string, unknown> | undefined)?.datum_lon)}</span>
              <span>Source</span>
              <span>{String((activeSnapshot.datum as Record<string, unknown> | undefined)?.last_set_source ?? "n/a")}</span>
              <span>Last set</span>
              <span>{formatInfoTimestamp((activeSnapshot.datum as Record<string, unknown> | undefined)?.last_set_epoch_ms)}</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>RTK Source</h4>
            <div className="key-value-grid">
              <span>Connected</span>
              <span>{(activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.connected === true ? "yes" : "no"}</span>
              <span>Label</span>
              <span>{String((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_label ?? "n/a")}</span>
              <span>RTCM age</span>
              <span>{formatInfoNumber((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.rtcm_age_s, 1)} s</span>
              <span>Received count</span>
              <span>{formatInfoNumber((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.received_count, 0)}</span>
              <span>Last error</span>
              <span>{String((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.last_error ?? "none")}</span>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "topics" ? (
        <div className="stack info-modal-topics">
          {topicsSnapshotError ? <div className="status-pill bad">{topicsSnapshotError}</div> : null}
          {state.topics.truncated ? <div className="status-pill">Historial truncado por limites de memoria.</div> : null}
          <div className="info-topics-layout">
            <div className="info-topics-sidebar">
              <input
                value={state.topics.search}
                onChange={(event) => {
                  sensorInfoService.setTopicSearch(event.target.value);
                }}
                placeholder="Buscar topic..."
              />
              <ul className="info-topics-list">
              {topicRows.map((entry) => (
                <li key={entry.name} className="feed-item">
                  <button
                    type="button"
                    className={entry.name === state.topics.selectedTopic ? "active" : ""}
                    onClick={() => {
                      void sensorInfoService.selectTopic(entry.name);
                    }}
                  >
                    {entry.name}
                  </button>
                  <div className="muted">
                    pub={entry.publisherCount} · sub={entry.subscriberCount}
                  </div>
                </li>
              ))}
              {topicRows.length === 0 ? <li className="feed-item muted">No hay topics.</li> : null}
              </ul>
            </div>
            <div className="panel-card info-topics-content">
              <div className="info-topics-content-header">
                <strong>{state.topics.selectedTopic || "Topics stream"}</strong>
                <div className="info-topics-selected-meta">
                  {state.topics.selectedType ? (
                    <span className="info-topics-selected-badge">{state.topics.selectedType}</span>
                  ) : null}
                  <span className="info-topics-selected-badge">
                    {selectedTopicMeta
                      ? `pub=${selectedTopicMeta.publisherCount} · sub=${selectedTopicMeta.subscriberCount}`
                      : "pub=n/a · sub=n/a"}
                  </span>
                </div>
              </div>
              <pre className="code-block info-topics-stream">
                {state.topics.historyText || "Selecciona un topic para ver su stream en tiempo real."}
              </pre>
              <div className="row">
                <button
                  type="button"
                  disabled={!state.topics.historyText}
                  onClick={async () => {
                    if (typeof navigator === "undefined" || !navigator.clipboard) return;
                    await navigator.clipboard.writeText(state.topics.historyText);
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Topic history copied",
                      timestamp: Date.now()
                    });
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "pixhawk_gps" ? (
        <div className="info-card-grid info-card-grid-pixhawk selectable">
          <div className="panel-card">
            <h4>IMU (EKF)</h4>
            <div className="key-value-grid">
              <span>q.w</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.w, 4)}</span>
              <span>q.x</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.x, 4)}</span>
              <span>q.y</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.y, 4)}</span>
              <span>q.z</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.z, 4)}</span>
              <span>yaw ENU</span>
              <span>{formatInfoNumber((activeSnapshot.imu as Record<string, unknown> | undefined)?.yaw_enu_deg, 2)} deg</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>GPS</h4>
            <div className="key-value-grid">
              <span>lat</span>
              <span>{formatInfoCoordinate((activeSnapshot.gps as Record<string, unknown> | undefined)?.latitude)}</span>
              <span>lon</span>
              <span>{formatInfoCoordinate((activeSnapshot.gps as Record<string, unknown> | undefined)?.longitude)}</span>
              <span>alt</span>
              <span>{formatInfoNumber((activeSnapshot.gps as Record<string, unknown> | undefined)?.altitude, 2)} m</span>
              <span>fix</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.fix_type_name ?? "n/a")}</span>
              <span>rtk status</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.rtk_status ?? "n/a")}</span>
              <span>satellites</span>
              <span>{formatInfoNumber((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.satellites_visible, 0)}</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Velocity</h4>
            <div className="key-value-grid">
              <span>vx</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.x, 3)} m/s</span>
              <span>vy</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.y, 3)} m/s</span>
              <span>vz</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.z, 3)} m/s</span>
              <span>yaw rate</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.angular as Record<string, unknown> | undefined)?.z, 3)} rad/s</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Odometry (EKF)</h4>
            <div className="key-value-grid">
              <span>x</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.x, 3)} m</span>
              <span>y</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.y, 3)} m</span>
              <span>z</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.z, 3)} m</span>
              <span>yaw ENU</span>
              <span>{formatInfoNumber((activeSnapshot.odom as Record<string, unknown> | undefined)?.yaw_enu_deg, 2)} deg</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Yaw Diagnostics</h4>
            <div className="key-value-grid">
              <span>Delta yaw</span>
              <span>{formatInfoNumber((activeSnapshot.diagnostics as Record<string, unknown> | undefined)?.yaw_delta_deg, 2)} deg</span>
              <span>Diferencias</span>
              <span>{formatInfoNumber((activeSnapshot.diagnostics as Record<string, unknown> | undefined)?.diferencias, 3)}</span>
              <span>ENU convention</span>
              <span>0°=E, 90°=N</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Topic Bindings</h4>
            <div className="key-value-grid">
              <span>IMU</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.imu ?? "--")}</span>
              <span>GPS</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.gps ?? "--")}</span>
              <span>Velocity</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.velocity ?? "--")}</span>
              <span>Odom</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.odom ?? "--")}</span>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "lidar" ? (
        <div className="panel-card">
          <strong>LiDAR</strong>
          <p className="muted">
            {state.implemented.lidar ? "LiDAR telemetry available" : "No LiDAR stream attached in this environment."}
          </p>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "camera" ? (
        <div className="panel-card">
          <strong>Camera</strong>
          <p className="muted">
            {state.implemented.camera
              ? "Camera telemetry stream enabled via set_sensor_info_view."
              : "PTZ control path: service.navigation → dispatcher.robot → transport.ws.core"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function registerTransport(ctx: ModuleContext): void {
  const transport = new WebSocketTransport(TRANSPORT_ID, ({ env }) => env.wsUrl);
  ctx.transports.registerTransport({
    id: transport.id,
    transport
  });
}

function registerDispatcher(ctx: ModuleContext): RobotDispatcher {
  const dispatcher = new RobotDispatcher(DISPATCHER_ID, TRANSPORT_ID);
  ctx.dispatchers.registerDispatcher({
    id: dispatcher.id,
    dispatcher
  });
  return dispatcher;
}

function registerServices(
  ctx: ModuleContext,
  dispatcher: RobotDispatcher
): { navigationService: NavigationService; connectionService: ConnectionService } {
  const config = readNav2Config(ctx);
  const limits = parseManualSpeedLimits(config);
  const navigationService = new NavigationService(dispatcher, {
    linearMin: limits.linearMin,
    linearMax: limits.linearMax,
    angularMin: limits.angularMin,
    angularMax: limits.angularMax,
    linearSpeed: parseNumberInRange(config.manual_linear_speed_default, 1.2, limits.linearMin, limits.linearMax),
    angularSpeed: parseNumberInRange(config.manual_angular_speed_default, 0.4, limits.angularMin, limits.angularMax),
    loopIntervalMs: parseLoopIntervalMs(config.manual_loop_interval_ms, 50)
  });
  ctx.services.registerService({
    id: NAVIGATION_SERVICE_ID,
    service: navigationService
  });

  const connectionService = new ConnectionService(
    ctx.transportManager,
    ctx.env,
    dispatcher.transportId,
    ctx.eventBus,
    buildConnectionPresetDefaults(ctx, config)
  );
  ctx.services.registerService({
    id: CONNECTION_SERVICE_ID,
    service: connectionService
  });
  ctx.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
    const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
    if (packageId !== "nav2") return;
    const nextConfig = (payload.config ?? {}) as Nav2RuntimeConfig;
    const nextLimits = parseManualSpeedLimits(nextConfig);
    connectionService.applyPresetDefaults(buildConnectionPresetDefaults(ctx, nextConfig));
    navigationService.applyRuntimeDefaults({
      linearMin: nextLimits.linearMin,
      linearMax: nextLimits.linearMax,
      angularMin: nextLimits.angularMin,
      angularMax: nextLimits.angularMax,
      linearSpeed: parseNumberInRange(nextConfig.manual_linear_speed_default, 1.2, nextLimits.linearMin, nextLimits.linearMax),
      angularSpeed: parseNumberInRange(nextConfig.manual_angular_speed_default, 0.4, nextLimits.angularMin, nextLimits.angularMax),
      loopIntervalMs: parseLoopIntervalMs(nextConfig.manual_loop_interval_ms, 50)
    });
  });

  const sensorInfoService = new SensorInfoService(dispatcher);
  ctx.services.registerService({
    id: SENSOR_INFO_SERVICE_ID,
    service: sensorInfoService
  });

  return { navigationService, connectionService };
}

function registerSidebarPanels(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "sidebar.connection",
    slot: "sidebar",
    label: "Connection",
    icon: "🔌",
    render: () => <ConnectionSidebarPanel runtime={ctx} />
  });
  ctx.contributions.register({
    id: "sidebar.navigation",
    slot: "sidebar",
    label: "Navigation",
    icon: "🧭",
    render: () => <NavigationSidebarPanel runtime={ctx} />
  });
}

function registerModals(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "modal.snapshot",
    slot: "modal",
    title: "Navigation Snapshot",
    render: () => <SnapshotModal runtime={ctx} />,
    renderFooter: () => <SnapshotModalFooter runtime={ctx} />
  });
  ctx.contributions.register({
    id: "modal.info",
    slot: "modal",
    title: "Info",
    render: () => <InfoModal runtime={ctx} />,
    renderFooter: () => <InfoModalFooter runtime={ctx} />
  });
}

function registerFooterItems(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "footer.connection-status",
    slot: "footer",
    beforeId: "core.footer.metrics",
    render: () => <ConnectionStatusFooterItem runtime={ctx} />
  });
}

function registerCommands(
  ctx: ModuleContext,
  navigationService: NavigationService,
  connectionService: ConnectionService
): void {
  ctx.commands.register(
    { id: NavigationCommands.connectionConnect, title: "Connection Connect", category: "Navigation" },
    () => {
      void connectionService.connect().catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Connection command failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionDisconnect, title: "Connection Disconnect", category: "Navigation" },
    () => {
      void connectionService.disconnect().catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Disconnect command failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetPreset, title: "Connection Set Preset", category: "Navigation" },
    (preset?: unknown) => {
      connectionService.setPreset(preset === "sim" ? "sim" : "real");
      const state = connectionService.getState();
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection preset set to ${state.preset}`,
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetHost, title: "Connection Set Host", category: "Navigation" },
    (host?: unknown) => {
      if (typeof host !== "string" || host.trim().length === 0) return;
      connectionService.setHost(host.trim());
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection host set to ${host.trim()}`,
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetPort, title: "Connection Set Port", category: "Navigation" },
    (port?: unknown) => {
      if (typeof port !== "string" || port.trim().length === 0) return;
      connectionService.setPort(port.trim());
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection port set to ${port.trim()}`,
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.openSnapshotModal, title: "Open Snapshot Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.snapshot");
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.captureSnapshot, title: "Capture Snapshot", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.snapshot");
      navigationService.requestSnapshot().then(() => {
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: "Snapshot captured (hotkey)",
          timestamp: Date.now()
        });
      }).catch((error: unknown) => {
        const message = String(error);
        if (message.toLowerCase().includes("camera disabled in current preset")) {
          ctx.eventBus.emit("console.event", {
            level: "info",
            text: "Snapshot no disponible para el preset de conexión actual.",
            timestamp: Date.now()
          });
          return;
        }
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Snapshot capture failed: ${message}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.openInfoModal, title: "Open Info Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.info");
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.swapWorkspace, title: "Swap Workspace", category: "Navigation" },
    () => {
      ctx.eventBus.emit(NAV_EVENTS.swapWorkspaceRequest, {});
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleGoalMode, title: "Toggle Goal Mode", category: "Navigation" },
    () => {
      const enabled = navigationService.toggleGoalMode();
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: enabled ? "Goal mode enabled (hotkey)" : "Goal mode disabled (hotkey)",
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleManualMode, title: "Toggle Manual Mode", category: "Navigation" },
    () => {
      const current = navigationService.getState().manualMode;
      void navigationService.setManualMode(!current).then(() => {
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: !current ? "Manual mode enabled (hotkey)" : "Manual mode disabled (hotkey)",
          timestamp: Date.now()
        });
      }).catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Manual mode hotkey failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleCameraZoom, title: "Toggle Camera Zoom", category: "Navigation" },
    () => { void navigationService.toggleCameraZoom(); }
  );

  const manualKeys: Array<[string, string, "w" | "a" | "s" | "d", boolean]> = [
    [NavigationCommands.manualKeyWDown, "Manual W Down", "w", true],
    [NavigationCommands.manualKeyWUp,   "Manual W Up",   "w", false],
    [NavigationCommands.manualKeyADown, "Manual A Down", "a", true],
    [NavigationCommands.manualKeyAUp,   "Manual A Up",   "a", false],
    [NavigationCommands.manualKeySDown, "Manual S Down", "s", true],
    [NavigationCommands.manualKeySUp,   "Manual S Up",   "s", false],
    [NavigationCommands.manualKeyDDown, "Manual D Down", "d", true],
    [NavigationCommands.manualKeyDUp,   "Manual D Up",   "d", false],
  ];
  for (const [id, title, key, pressed] of manualKeys) {
    ctx.commands.register({ id, title, category: "Navigation" }, () => {
      navigationService.setManualKeyState(key, pressed);
    });
  }

  ctx.commands.register(
    { id: NavigationCommands.manualBrakeDown, title: "Manual Brake Down", category: "Navigation" },
    () => { navigationService.setManualBrakeHeld(true); }
  );
  ctx.commands.register(
    { id: NavigationCommands.manualBrakeUp, title: "Manual Brake Up", category: "Navigation" },
    () => { navigationService.setManualBrakeHeld(false); }
  );

  const cameraCommands: Array<[string, string, number]> = [
    [NavigationCommands.panCameraUp,    "Pan Camera Up",    0],
    [NavigationCommands.panCameraDown,  "Pan Camera Down",  180],
    [NavigationCommands.panCameraLeft,  "Pan Camera Left",  90],
    [NavigationCommands.panCameraRight, "Pan Camera Right", -90],
  ];
  for (const [id, title, angle] of cameraCommands) {
    ctx.commands.register({ id, title, category: "Navigation" }, () => {
      void navigationService.panCamera(angle);
    });
  }

  ctx.commands.register(
    { id: NavigationCommands.dismissEscape, title: "Dismiss (Escape)", category: "Navigation" },
    () => {
      if (navigationService.getState().goalMode) {
        navigationService.toggleGoalMode();
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: "Goal mode disabled (Esc)",
          timestamp: Date.now()
        });
      }
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.downloadSnapshot, title: "Download Snapshot", category: "Navigation" },
    () => { ctx.eventBus.emit(NAV_EVENTS.snapshotDownloadRequest, {}); }
  );

  // Keybindings
  ctx.keybindings.register({ key: "q", commandId: NavigationCommands.captureSnapshot, source: "default" });
  ctx.keybindings.register({ key: "i", commandId: NavigationCommands.openInfoModal, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "e", commandId: NavigationCommands.swapWorkspace, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "f", commandId: NavigationCommands.toggleGoalMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "m", commandId: NavigationCommands.toggleManualMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "-", commandId: NavigationCommands.toggleCameraZoom, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "w", commandId: NavigationCommands.manualKeyWDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "a", commandId: NavigationCommands.manualKeyADown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "s", commandId: NavigationCommands.manualKeySDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "d", commandId: NavigationCommands.manualKeyDDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "space", commandId: NavigationCommands.manualBrakeDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "w:up", commandId: NavigationCommands.manualKeyWUp, source: "default" });
  ctx.keybindings.register({ key: "a:up", commandId: NavigationCommands.manualKeyAUp, source: "default" });
  ctx.keybindings.register({ key: "s:up", commandId: NavigationCommands.manualKeySUp, source: "default" });
  ctx.keybindings.register({ key: "d:up", commandId: NavigationCommands.manualKeyDUp, source: "default" });
  ctx.keybindings.register({ key: "space:up", commandId: NavigationCommands.manualBrakeUp, source: "default" });
  ctx.keybindings.register({ key: "shift+up", commandId: NavigationCommands.panCameraUp, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+down", commandId: NavigationCommands.panCameraDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+left", commandId: NavigationCommands.panCameraLeft, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+right", commandId: NavigationCommands.panCameraRight, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "escape", commandId: NavigationCommands.dismissEscape, source: "default", when: "!modalOpen", weight: -1 });
}

export function createNavigationModule(): CockpitModule {
  return {
    id: "navigation",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      registerTransport(ctx);
      const dispatcher = registerDispatcher(ctx);
      const { navigationService, connectionService } = registerServices(ctx, dispatcher);
      registerCommands(ctx, navigationService, connectionService);
      registerSidebarPanels(ctx);
      registerModals(ctx);
      registerFooterItems(ctx);
    }
  };
}

import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import type { RobotDispatcher } from "../../navigation/dispatcher/impl/RobotDispatcher";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import type { NavigationService } from "../../navigation/service/impl/NavigationService";
import type { SensorInfoService, SensorInfoState } from "../../navigation/service/impl/SensorInfoService";
import { TelemetryService, type TelemetrySnapshot } from "../service/impl/TelemetryService";

const SERVICE_ID = "service.telemetry";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";

function resolveOptionalServices(runtime: ModuleContext): {
  navigation: NavigationService | null;
  connection: ConnectionService | null;
  sensorInfo: SensorInfoService | null;
} {
  try {
    const navigation = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
    const connection = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
    const sensorInfo = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
    return { navigation, connection, sensorInfo };
  } catch {
    return { navigation: null, connection: null, sensorInfo: null };
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

function parseNumericValue(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function padTelemetryNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTelemetryClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
  const date = new Date(timestamp);
  return `${padTelemetryNumber(date.getHours())}:${padTelemetryNumber(date.getMinutes())}:${padTelemetryNumber(date.getSeconds())}`;
}

function isTelemetryEventToday(timestamp: number, nowMs: number): boolean {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const eventDate = new Date(timestamp);
  const today = new Date(nowMs);
  return (
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate()
  );
}

function telemetryEventTone(event: TelemetrySnapshot["recentEvents"][number]): "info" | "success" | "warning" | "critical" | "detection" {
  const level = event.level.trim().toLowerCase();
  const code = String(event.code ?? "").trim().toLowerCase();
  const text = event.text.trim().toLowerCase();
  if (level === "critical" || level === "error" || level === "err" || level === "fatal") return "critical";
  if (level === "warn" || level === "warning") return "warning";
  if (code.includes("detection") || text.includes("detected") || text.includes("object")) return "detection";
  if (
    code.includes("succeeded") ||
    text.includes("connected") ||
    text.includes("online") ||
    text.includes("restored") ||
    text.includes("reached")
  ) {
    return "success";
  }
  return "info";
}

function telemetryEventLevelLabel(event: TelemetrySnapshot["recentEvents"][number]): string {
  const tone = telemetryEventTone(event);
  if (tone === "warning") return "WARNING";
  if (tone === "critical") return "CRITICAL";
  if (tone === "detection") return "DETECTION";
  return "INFO";
}

function telemetryEventDetail(event: TelemetrySnapshot["recentEvents"][number]): string {
  if (event.code?.trim()) return event.code.trim().replace(/_/g, " ");
  const tone = telemetryEventTone(event);
  if (tone === "success") return "Estado normal";
  if (tone === "warning") return "Revision requerida";
  if (tone === "critical") return "Atencion inmediata";
  if (tone === "detection") return "Evento de percepcion";
  return "Evento del sistema";
}

function TelemetryIcon({
  kind,
  className = ""
}: {
  kind: "pulse" | "warning" | "critical" | "clock" | "list" | "bell" | "camera" | "check" | "info";
  className?: string;
}): JSX.Element {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className
  };

  if (kind === "warning") {
    return (
      <svg {...props}>
        <path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }

  if (kind === "critical") {
    return (
      <svg {...props}>
        <path d="M12 3 5 6v5c0 4.1 2.8 7.8 7 9 4.2-1.2 7-4.9 7-9V6l-7-3Z" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
    );
  }

  if (kind === "clock") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </svg>
    );
  }

  if (kind === "list") {
    return (
      <svg {...props}>
        <path d="M8 6h12" />
        <path d="M8 12h12" />
        <path d="M8 18h12" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
    );
  }

  if (kind === "bell") {
    return (
      <svg {...props}>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </svg>
    );
  }

  if (kind === "camera") {
    return (
      <svg {...props}>
        <rect x="4" y="7" width="12" height="10" rx="2" />
        <path d="m16 10 4-2v8l-4-2" />
        <circle cx="10" cy="12" r="2" />
      </svg>
    );
  }

  if (kind === "check") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    );
  }

  if (kind === "info") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </svg>
    );
  }

  return (
    <svg {...props}>
      <path d="M4 12h4l2-5 4 10 2-5h4" />
    </svg>
  );
}

function StatusChip({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "neutral" | "ok" | "warn" | "off";
}): JSX.Element {
  return <span className={`telemetry-chip telemetry-chip-${tone}`}>{label}</span>;
}

function SummaryCard({
  title,
  value,
  detail,
  tone = "neutral"
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "neutral" | "ok" | "warn" | "off";
}): JSX.Element {
  return (
    <div className={`telemetry-summary-card telemetry-summary-card-${tone}`}>
      <span className="telemetry-summary-title">{title}</span>
      <strong className="telemetry-summary-value">{value}</strong>
      <span className="telemetry-summary-detail">{detail}</span>
    </div>
  );
}

function TelemetryMetricCard({
  label,
  value,
  detail,
  icon,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  icon: "pulse" | "warning" | "critical" | "clock";
  tone: "info" | "warning" | "critical" | "success";
}): JSX.Element {
  return (
    <div className={`telemetry-console-metric telemetry-console-metric-${tone}`}>
      <span className="telemetry-console-metric-icon" aria-hidden="true">
        <TelemetryIcon kind={icon} />
      </span>
      <span className="telemetry-console-metric-copy">
        <span className="telemetry-console-metric-label">{label}</span>
        <strong className="telemetry-console-metric-value">{value}</strong>
        <span className="telemetry-console-metric-detail">{detail}</span>
      </span>
    </div>
  );
}

function TelemetryEventIcon({ tone }: { tone: ReturnType<typeof telemetryEventTone> }): JSX.Element {
  const icon =
    tone === "warning" ? "warning" :
    tone === "critical" ? "critical" :
    tone === "success" ? "check" :
    tone === "detection" ? "camera" :
    "info";
  return <TelemetryIcon kind={icon} />;
}

function TelemetryEventRow({
  event,
  variant,
  recent
}: {
  event: TelemetrySnapshot["recentEvents"][number];
  variant: "events" | "alerts";
  recent: boolean;
}): JSX.Element {
  const tone = telemetryEventTone(event);
  return (
    <div className={`telemetry-console-row telemetry-console-row-${variant} telemetry-console-row-${tone} ${recent ? "is-recent" : ""}`}>
      <span className="telemetry-console-row-time">
        <span className="telemetry-console-row-dot" aria-hidden="true" />
        {formatTelemetryClock(event.timestamp)}
      </span>
      <span className="telemetry-console-row-icon" aria-hidden="true">
        <TelemetryEventIcon tone={tone} />
      </span>
      <span className="telemetry-console-row-copy">
        <strong>{event.text}</strong>
        <span>{telemetryEventDetail(event)}</span>
      </span>
      <span className={`telemetry-console-row-chip telemetry-console-row-chip-${tone}`}>
        {telemetryEventLevelLabel(event)}
      </span>
    </div>
  );
}

function TelemetryEmptyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="telemetry-console-empty">
      <span className="telemetry-console-empty-icon" aria-hidden="true">
        <TelemetryIcon kind="info" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function TelemetrySidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const services = resolveOptionalServices(runtime);
  const telemetryService = runtime.services.getService<TelemetryService>(SERVICE_ID);
  const [sensorInfoState, setSensorInfoState] = useState<SensorInfoState | null>(
    services.sensorInfo ? services.sensorInfo.getState() : null
  );
  const [connectionState, setConnectionState] = useState(
    services.connection ? services.connection.getState() : null
  );
  const [navigationState, setNavigationState] = useState(
    services.navigation ? services.navigation.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot>(telemetryService.getSnapshot());
  const pixhawkPayload = sensorInfoState?.payloads.pixhawk_gps as Record<string, unknown> | undefined;
  const pixhawkSnapshot = (pixhawkPayload?.snapshot ?? {}) as Record<string, unknown>;

  useEffect(() => {
    if (!services.sensorInfo) return;
    return services.sensorInfo.subscribe((next) => setSensorInfoState(next));
  }, [services.sensorInfo]);

  useEffect(() => {
    if (!services.connection) return;
    return services.connection.subscribe((next) => setConnectionState(next));
  }, [services.connection]);

  useEffect(() => {
    if (!services.navigation) return;
    return services.navigation.subscribe((next) => setNavigationState(next));
  }, [services.navigation]);

  useEffect(() => telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next)), [telemetryService]);

  useEffect(() => {
    if (!services.sensorInfo) return;
    void services.sensorInfo.open();
    return () => {
      void services.sensorInfo!.close();
    };
  }, [services.sensorInfo]);

  const datumState = telemetrySnapshot.datum ?? {};
  const rtkState = telemetrySnapshot.rtkSourceState ?? {};
  const gpsStatus = telemetrySnapshot.gpsStatus ?? {};
  const yawDiagnostics = (pixhawkSnapshot.diagnostics as Record<string, unknown> | undefined) ?? {};
  const yawDelta = parseNumericValue(yawDiagnostics.yaw_delta_deg);
  const yawTone =
    yawDelta === null ? "neutral" :
    Math.abs(yawDelta) <= 10 ? "ok" :
    Math.abs(yawDelta) <= 25 ? "warn" :
    "off";
  const alertsCount = telemetrySnapshot.alerts.length;
  const eventsCount = telemetrySnapshot.recentEvents.length;
  const connectionTone = connectionState?.connected ? "ok" : "off";
  const cameraTone = navigationState?.cameraStreamConnected ? "ok" : "warn";
  const datumTone = datumState.already_set === true ? "ok" : "warn";
  const alertsTone = alertsCount > 0 ? "warn" : "ok";
  const gpsLevel = String(gpsStatus.level ?? "");
  const gpsTone: "ok" | "warn" | "off" | "neutral" =
    gpsLevel === "ok" ? "ok" : gpsLevel === "warn" ? "warn" : gpsLevel === "error" ? "off" : "neutral";
  const rtkNtripAvailable = rtkState.active_source_label !== undefined;

  return (
    <div className="stack telemetry-sidebar">
      <div className="telemetry-summary-grid">
        <SummaryCard
          title="Backend"
          value={connectionState?.connected ? "Linked" : "Offline"}
          detail={connectionState?.connected ? "ROS bridge healthy" : String(connectionState?.lastError ?? "No active session")}
          tone={connectionTone}
        />
        <SummaryCard
          title="Camera Stream"
          value={navigationState?.cameraStreamConnected ? "Live" : "Idle"}
          detail={navigationState?.cameraStreamConnected ? "Frames available to UI" : "Awaiting feed"}
          tone={cameraTone}
        />
        <SummaryCard
          title="Datum"
          value={datumState.already_set === true ? "Set" : "Unset"}
          detail={`Source ${String(datumState.last_set_source ?? "n/a")}`}
          tone={datumTone}
        />
        <SummaryCard
          title="Alerts"
          value={String(alertsCount)}
          detail={`${eventsCount} recent events`}
          tone={alertsTone}
        />
      </div>

      <div className="panel-card telemetry-panel-card">
        <div className="telemetry-card-header">
          <h4>Datum</h4>
          <StatusChip label={datumState.already_set === true ? "set" : "unset"} tone={datumTone} />
        </div>
        <div className="key-value-grid telemetry-kv-grid">
          <span>Status</span>
          <span>{datumState.already_set === true ? "set" : "unset"}</span>
          <span>Latitude</span>
          <span>{formatInfoCoordinate(datumState.datum_lat)}</span>
          <span>Longitude</span>
          <span>{formatInfoCoordinate(datumState.datum_lon)}</span>
          <span>Source</span>
          <span>{String(datumState.last_set_source ?? "n/a")}</span>
          <span>Last set</span>
          <span>{formatInfoTimestamp(datumState.last_set_epoch_ms)}</span>
        </div>
      </div>

      <div className="panel-card telemetry-panel-card">
        <div className="telemetry-card-header">
          <h4>GPS Fix</h4>
          <StatusChip
            label={gpsStatus.available === true ? String(gpsStatus.label ?? "unknown") : "no signal"}
            tone={gpsTone}
          />
        </div>
        <div className="key-value-grid telemetry-kv-grid">
          <span>Fix type</span>
          <span>{String(gpsStatus.label ?? "n/a")}</span>
          <span>Source</span>
          <span>{String(gpsStatus.source ?? "n/a")}</span>
          <span>Raw status</span>
          <span>{String(gpsStatus.raw ?? "n/a")}</span>
        </div>
        {rtkNtripAvailable && (
          <>
            <div className="telemetry-card-header" style={{ marginTop: "0.5rem" }}>
              <h4>RTK Corrections</h4>
              <StatusChip label={rtkState.connected === true ? "connected" : "offline"} tone={rtkState.connected === true ? "ok" : "off"} />
            </div>
            <div className="key-value-grid telemetry-kv-grid">
              <span>Source</span>
              <span>{String(rtkState.active_source_label ?? "n/a")}</span>
              <span>RTCM age</span>
              <span>{formatInfoNumber(rtkState.rtcm_age_s, 1)} s</span>
              <span>Corrections rx</span>
              <span>{formatInfoNumber(rtkState.received_count, 0)}</span>
              <span>Last error</span>
              <span>{String(rtkState.last_error ?? "none")}</span>
            </div>
          </>
        )}
      </div>

      <div className="panel-card telemetry-panel-card">
        <div className="telemetry-card-header">
          <h4>Yaw Diagnostics</h4>
          <StatusChip
            label={
              yawTone === "ok" ? "stable" :
              yawTone === "warn" ? "review" :
              yawTone === "off" ? "high delta" :
              "n/a"
            }
            tone={yawTone}
          />
        </div>
        <div className="key-value-grid telemetry-kv-grid">
          <span>Delta yaw</span>
          <span>{formatInfoNumber(yawDiagnostics.yaw_delta_deg, 2)} deg</span>
          <span>Diferencias</span>
          <span>{formatInfoNumber(yawDiagnostics.diferencias, 3)}</span>
          <span>ENU convention</span>
          <span>0°=E, 90°=N</span>
        </div>
      </div>
    </div>
  );
}

function TelemetryConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<TelemetryService>(SERVICE_ID);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(service.getSnapshot());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const recentEventsToday = snapshot.recentEvents.filter((event) => isTelemetryEventToday(event.timestamp, nowMs));
  const alertsToday = snapshot.alerts.filter((event) => isTelemetryEventToday(event.timestamp, nowMs));
  const warningsToday = alertsToday.filter((event) => telemetryEventTone(event) === "warning").length;
  const criticalToday = alertsToday.filter((event) => telemetryEventTone(event) === "critical").length;
  const visibleEvents = showAllEvents ? snapshot.recentEvents : snapshot.recentEvents.slice(0, 5);
  const visibleAlerts = showAllAlerts ? snapshot.alerts : snapshot.alerts.slice(0, 5);
  const currentTime = formatTelemetryClock(nowMs);

  return (
    <div className="telemetry-console-dashboard">
      <div className="telemetry-console-summary" aria-label="Telemetry summary">
        <TelemetryMetricCard
          label="Events"
          value={String(recentEventsToday.length)}
          detail="Hoy"
          icon="pulse"
          tone="info"
        />
        <TelemetryMetricCard
          label="Warnings"
          value={String(warningsToday)}
          detail="Hoy"
          icon="warning"
          tone="warning"
        />
        <TelemetryMetricCard
          label="Critical"
          value={String(criticalToday)}
          detail="Hoy"
          icon="critical"
          tone="critical"
        />
        <TelemetryMetricCard
          label="Hora local"
          value={currentTime}
          detail="En vivo"
          icon="clock"
          tone="success"
        />
      </div>

      <div className="telemetry-console-panels">
        <section className="telemetry-console-card telemetry-console-card-events">
          <div className="telemetry-console-card-header">
            <div className="telemetry-console-card-title">
              <TelemetryIcon kind="list" />
              <h3>Recent Events</h3>
            </div>
            <button
              type="button"
              className="telemetry-console-more-btn"
              onClick={() => setShowAllEvents((prev) => !prev)}
            >
              {showAllEvents ? "Ver menos" : "Ver todos"}
              <span aria-hidden="true">›</span>
            </button>
          </div>
          <div className="telemetry-console-list">
            {visibleEvents.length === 0 ? (
              <TelemetryEmptyState label="Sin eventos" />
            ) : (
              visibleEvents.map((entry, index) => (
                <TelemetryEventRow
                  key={`${entry.timestamp}.${index}.event`}
                  event={entry}
                  variant="events"
                  recent={nowMs - entry.timestamp <= 5000}
                />
              ))
            )}
          </div>
          <button
            type="button"
            className="telemetry-console-footer-btn"
            onClick={() => setShowAllEvents((prev) => !prev)}
          >
            {showAllEvents ? "Ver menos eventos" : "Ver todos los eventos"}
            <span aria-hidden="true">›</span>
          </button>
        </section>

        <section className="telemetry-console-card telemetry-console-card-alerts">
          <div className="telemetry-console-card-header">
            <div className="telemetry-console-card-title">
              <TelemetryIcon kind="bell" />
              <h3>Alerts Timeline</h3>
            </div>
            <button
              type="button"
              className="telemetry-console-more-btn"
              onClick={() => setShowAllAlerts((prev) => !prev)}
            >
              {showAllAlerts ? "Ver menos" : "Ver todas"}
              <span aria-hidden="true">›</span>
            </button>
          </div>
          <div className="telemetry-console-list telemetry-console-alert-list">
            {visibleAlerts.length === 0 ? (
              <TelemetryEmptyState label="Sin alertas" />
            ) : (
              visibleAlerts.map((entry, index) => (
                <TelemetryEventRow
                  key={`${entry.timestamp}.${index}.alert`}
                  event={entry}
                  variant="alerts"
                  recent={nowMs - entry.timestamp <= 5000}
                />
              ))
            )}
          </div>
          <button
            type="button"
            className="telemetry-console-footer-btn"
            onClick={() => setShowAllAlerts((prev) => !prev)}
          >
            {showAllAlerts ? "Ver menos alertas" : "Ver todas las alertas"}
            <span aria-hidden="true">›</span>
          </button>
        </section>
      </div>
    </div>
  );
}

export function createTelemetryModule(): CockpitModule {
  return {
    id: "telemetry",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcherDefinition = ctx.dispatchers.get(DISPATCHER_ID);
      if (!dispatcherDefinition) return;

      const robotDispatcher = dispatcherDefinition.dispatcher as RobotDispatcher;
      const telemetryService = new TelemetryService(robotDispatcher, ctx.eventBus);
      ctx.services.registerService({
        id: SERVICE_ID,
        service: telemetryService
      });

      ctx.contributions.register({
        id: "sidebar.telemetry",
        slot: "sidebar",
        label: "Telemetry",
        icon: "📡",
        render: () => <TelemetrySidebarPanel runtime={ctx} />
      });

      ctx.contributions.register({
        id: "console.telemetry",
        slot: "console",
        label: "Telemetry",
        render: () => <TelemetryConsoleTab runtime={ctx} />
      });
    }
  };
}

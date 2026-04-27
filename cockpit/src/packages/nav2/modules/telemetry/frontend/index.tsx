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
  const generalPayload = sensorInfoState?.payloads.general as Record<string, unknown> | undefined;
  const generalSnapshot = (generalPayload?.snapshot ?? {}) as Record<string, unknown>;
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

  const datumState = (generalSnapshot.datum as Record<string, unknown> | undefined) ?? {};
  const rtkState = (generalSnapshot.rtk_source_state as Record<string, unknown> | undefined) ?? {};
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
          <h4>RTK Source</h4>
          <StatusChip label={rtkState.connected === true ? "connected" : "offline"} tone={rtkState.connected === true ? "ok" : "off"} />
        </div>
        <div className="key-value-grid telemetry-kv-grid">
          <span>Connected</span>
          <span>{rtkState.connected === true ? "yes" : "no"}</span>
          <span>Label</span>
          <span>{String(rtkState.active_source_label ?? "n/a")}</span>
          <span>RTCM age</span>
          <span>{formatInfoNumber(rtkState.rtcm_age_s, 1)} s</span>
          <span>Received count</span>
          <span>{formatInfoNumber(rtkState.received_count, 0)}</span>
          <span>Last error</span>
          <span>{String(rtkState.last_error ?? "none")}</span>
        </div>
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

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="tel-feed telemetry-console-feed">
      <div className="tel-feed-col">
        <div className="tel-feed-hdr">Recent Events</div>
        <div className="tel-feed-list">
          {snapshot.recentEvents.length === 0 ? (
            <div className="muted">No events.</div>
          ) : (
            snapshot.recentEvents.map((entry: TelemetrySnapshot["recentEvents"][number], index: number) => (
              <div key={`${entry.timestamp}.${index}`} className="tel-event">
                <div className="tel-event-msg">
                  <strong>{entry.level.toUpperCase()}</strong> {entry.text}
                </div>
                <div className="tel-event-meta">{new Date(entry.timestamp).toLocaleTimeString()}</div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="tel-feed-col">
        <div className="tel-feed-hdr">Alerts Timeline</div>
        <div className="tel-feed-list">
          {snapshot.alerts.length === 0 ? (
            <div className="muted">No alerts.</div>
          ) : (
            snapshot.alerts.map((entry: TelemetrySnapshot["alerts"][number], index: number) => (
              <div
                key={`${entry.timestamp}.${index}`}
                className={`tel-event ${nowMs - entry.timestamp <= 5000 ? "alert-recent" : ""}`}
              >
                <div className="tel-event-msg">
                  <strong>{entry.level.toUpperCase()}</strong> {entry.text}
                </div>
                <div className="tel-event-meta">{new Date(entry.timestamp).toLocaleTimeString()}</div>
              </div>
            ))
          )}
        </div>
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

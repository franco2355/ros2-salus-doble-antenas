import { useEffect, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import type { ConnectionState, ConnectionService } from "../../services/impl/ConnectionService";
import type { NavigationService, NavigationState } from "../../services/impl/NavigationService";
import { TelemetryService, type TelemetrySnapshot } from "../../services/impl/TelemetryService";

const SERVICE_ID = "service.telemetry";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";

function resolveOptionalServices(runtime: ModuleContext): {
  navigation: NavigationService | null;
  connection: ConnectionService | null;
} {
  try {
    const navigation = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
    const connection = runtime.registries.serviceRegistry.getService<ConnectionService>(CONNECTION_SERVICE_ID);
    return { navigation, connection };
  } catch {
    return { navigation: null, connection: null };
  }
}

function TelemetrySidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<TelemetryService>(SERVICE_ID);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(service.getSnapshot());
  const services = resolveOptionalServices(runtime);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    services.navigation ? services.navigation.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    services.connection ? services.connection.getState() : null
  );

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);
  useEffect(() => {
    if (!services.navigation) return;
    return services.navigation.subscribe((next) => setNavigationState(next));
  }, [services.navigation]);
  useEffect(() => {
    if (!services.connection) return;
    return services.connection.subscribe((next) => setConnectionState(next));
  }, [services.connection]);

  return (
    <div className="stack">
      <div className="panel-card status-board">
        <div className="status-row">
          <strong>Connection</strong>
          <span className={connectionState?.connected ? "status-ok" : "status-bad"}>
            {connectionState?.connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div className="status-row">
          <strong>Goal</strong>
          <span>{navigationState?.lastStatus ?? "n/a"}</span>
        </div>
        <div className="status-row">
          <strong>Waypoints</strong>
          <span>{navigationState?.waypoints.length ?? 0}</span>
        </div>
        <div className="status-row">
          <strong>Manual</strong>
          <span>{navigationState?.manualMode ? "ON" : "OFF"}</span>
        </div>
        <div className="status-row">
          <strong>Camera Stream</strong>
          <span>{navigationState?.cameraStreamConnected ? "Connected" : "Disconnected"}</span>
        </div>
        <div className="status-row">
          <strong>Robot</strong>
          <span>{snapshot.robotStatus.connected ? "Online" : "Offline"}</span>
        </div>
      </div>
      <div className="panel-card">
        <h4>Robot Status</h4>
        <div className="status-grid">
          <div>
            <strong>Mode</strong>
            <p className="muted">{snapshot.robotStatus.mode}</p>
          </div>
          <div>
            <strong>Battery</strong>
            <p className="muted">{Number(snapshot.robotStatus.batteryPct).toFixed(1)}%</p>
          </div>
          <div>
            <strong>Alerts</strong>
            <p className="muted">{snapshot.alerts.length} active</p>
          </div>
          <div>
            <strong>Events</strong>
            <p className="muted">{snapshot.recentEvents.length} buffered</p>
          </div>
        </div>
      </div>
      <div className="panel-card">
        <h4>Active Alerts</h4>
        {snapshot.alerts.length === 0 ? (
          <p className="muted">No active alerts.</p>
        ) : (
          <ul className="feed-list">
            {snapshot.alerts.slice(0, 6).map((entry, index) => (
              <li key={`${entry.timestamp}.${index}`} className="feed-item">
                <strong>{entry.level.toUpperCase()}</strong> {entry.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TelemetryConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<TelemetryService>(SERVICE_ID);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(service.getSnapshot());

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);

  return (
    <div className="feed-grid">
      <div className="panel-card">
        <h4>Recent Events</h4>
        {snapshot.recentEvents.length === 0 ? (
          <p className="muted">No events.</p>
        ) : (
          <ul className="feed-list">
            {snapshot.recentEvents.map((entry, index) => (
              <li key={`${entry.timestamp}.${index}`} className="feed-item">
                <div>
                  <strong>{entry.level.toUpperCase()}</strong> {entry.text}
                </div>
                <div className="muted">{new Date(entry.timestamp).toLocaleTimeString()}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel-card">
        <h4>Alerts Timeline</h4>
        {snapshot.alerts.length === 0 ? (
          <p className="muted">No alerts.</p>
        ) : (
          <ul className="feed-list">
            {snapshot.alerts.map((entry, index) => (
              <li key={`${entry.timestamp}.${index}`} className="feed-item">
                <div>
                  <strong>{entry.level.toUpperCase()}</strong> {entry.text}
                </div>
                <div className="muted">{new Date(entry.timestamp).toLocaleTimeString()}</div>
              </li>
            ))}
          </ul>
        )}
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
      const dispatcherDefinition = ctx.registries.dispatcherRegistry.get(DISPATCHER_ID);
      if (!dispatcherDefinition) return;

      const robotDispatcher = dispatcherDefinition.dispatcher as RobotDispatcher;
      const telemetryService = new TelemetryService(robotDispatcher, ctx.eventBus);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        order: 20,
        service: telemetryService
      });

      ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
        id: "sidebar.telemetry",
        label: "Telemetry",
        order: 15,
        render: (runtime) => <TelemetrySidebarPanel runtime={runtime} />
      });

      ctx.registries.consoleTabRegistry.registerConsoleTab({
        id: "console.telemetry",
        label: "Telemetry",
        order: 15,
        render: (runtime) => <TelemetryConsoleTab runtime={runtime} />
      });
    }
  };
}

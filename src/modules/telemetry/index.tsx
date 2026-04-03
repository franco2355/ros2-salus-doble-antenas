import { useEffect, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import { TelemetryService, type TelemetrySnapshot } from "../../services/impl/TelemetryService";

const SERVICE_ID = "service.telemetry";
const DISPATCHER_ID = "dispatcher.robot";

function TelemetrySidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<TelemetryService>(SERVICE_ID);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(service.getSnapshot());

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Telemetry</h3>
        <p className="muted">Connected: {snapshot.robotStatus.connected ? "yes" : "no"}</p>
        <p className="muted">Mode: {snapshot.robotStatus.mode}</p>
        <p className="muted">Battery: {Number(snapshot.robotStatus.batteryPct).toFixed(1)}%</p>
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
    <div className="stack">
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
    </div>
  );
}

export function createTelemetryModule(): CockpitModule {
  return {
    id: "telemetry",
    version: "1.1.0",
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


import { useEffect, useState } from "react";
import { NAV_EVENTS } from "../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import { notify } from "../../platform/tauri/notifications";
import { ConnectionService } from "../../services/impl/ConnectionService";
import { SensorInfoService, type SensorInfoTab } from "../../services/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../services/impl/TelemetryService";
import { NavigationService, type NavigationState, type SnapshotData } from "../../services/impl/NavigationService";
import { WebSocketTransport } from "../../transport/impl/WebSocketTransport";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function getTelemetryService(runtime: ModuleContext): TelemetryServiceLike | null {
  try {
    return runtime.registries.serviceRegistry.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    return null;
  }
}

function ConnectionSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Connection</h3>
        <p className="muted">Preset + host/port (migrado desde UI monolítica).</p>
        <div className="stack">
          <select
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
              disabled={state.connecting}
              onClick={async () => {
                try {
                  await service.connect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              {state.connecting ? "Connecting..." : "Connect"}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await service.disconnect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              Disconnect
            </button>
          </div>
          <div className={`status-pill ${state.connected ? "ok" : "bad"}`}>
            {state.connected ? "connected" : "disconnected"}
          </div>
          {state.lastError ? <p className="muted">Error: {state.lastError}</p> : null}
        </div>
      </div>
    </div>
  );
}

function NavigationSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [state, setState] = useState<NavigationState>(service.getState());
  const selectedCount = state.selectedWaypointIndexes.length;

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", {
      level: "info",
      text,
      timestamp: Date.now()
    });
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Navigation</h3>
        <p className="muted">Controles rápidos de navegación.</p>
        <div className="nav-legacy-row nav-legacy-top">
          <button
            type="button"
            className={state.goalMode ? "active" : ""}
            onClick={() => {
              const enabled = service.toggleGoalMode();
              emitInfo(enabled ? "Goal mode enabled" : "Goal mode disabled");
            }}
            title="Goal mode"
          >
            📌
          </button>
          <button
            type="button"
            onClick={() => {
              service.removeLastWaypoint();
              emitInfo("Last waypoint removed");
            }}
            disabled={state.waypoints.length === 0}
            title="Undo"
          >
            ↩
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              service.clearWaypoints();
              emitInfo("Waypoints cleared");
            }}
            disabled={state.waypoints.length === 0}
            title="Clear waypoints"
          >
            🗑
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              const removed = service.removeSelectedWaypoints();
              if (removed > 0) {
                emitInfo(`Removed ${removed} selected waypoint${removed > 1 ? "s" : ""}`);
              }
            }}
            disabled={selectedCount === 0}
            title="Remove selected"
          >
            🧹
          </button>
        </div>
        <div className="nav-legacy-row nav-legacy-primary">
          <button
            type="button"
            className="nav-legacy-send"
            onClick={async () => {
              try {
                const sent = await service.sendQueuedGoal();
                const sentCount = sent.sentCount;
                emitInfo(`Goal dispatch sent (${sentCount} waypoint${sentCount > 1 ? "s" : ""})`);
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Goal failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
            disabled={state.waypoints.length === 0 || state.controlLocked}
          >
            ➤ Send
          </button>
          <button
            type="button"
            className="danger-btn nav-legacy-cancel"
            onClick={async () => {
              try {
                await service.cancelGoal();
                emitInfo("Goal cancelled");
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Cancel failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            ⊗ Cancel
          </button>
        </div>
        <div className="nav-legacy-row nav-legacy-bottom">
          <button
            type="button"
            onClick={() => {
              const count = service.saveWaypoints();
              emitInfo(`Saved ${count} waypoints`);
            }}
            title="Save route"
          >
            💾
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                const count = service.loadWaypoints();
                emitInfo(`Loaded ${count} waypoints`);
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Load waypoints failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
            title="Load route"
          >
            📂
          </button>
          <button
            type="button"
            onClick={() => {
              const connected = service.toggleCameraStream();
              emitInfo(connected ? "Camera stream connected" : "Camera stream disconnected");
            }}
            title="Camera stream"
          >
            📸
          </button>
          <button
            type="button"
            onClick={async () => {
              const next = !state.manualMode;
              try {
                await service.setManualMode(next);
                emitInfo(next ? "Manual mode enabled" : "Manual mode disabled");
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Manual mode failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
            title="Manual mode"
            disabled={state.controlLocked}
          >
            {state.manualMode ? "ON" : "OFF"}
          </button>
        </div>
        <p className="nav-legacy-text">Queued: {state.waypoints.length}</p>
        <p className="nav-legacy-text">Selected: {selectedCount}</p>
        <p className="nav-legacy-text">Loop: {state.loopRoute ? "ON" : "OFF"}</p>
        <button
          type="button"
          className="nav-legacy-toggle"
          onClick={() => service.setLoopRoute(!state.loopRoute)}
          title="Toggle loop route"
        >
          Loop route: {state.loopRoute ? "ON" : "OFF"}
        </button>
        <p className="nav-legacy-text">
          Manual: {state.manualDisablePending ? "DISABLING" : state.manualMode ? "ON" : "OFF"} · keys=
          {service.getManualKeysSummary()} · vx={state.manualCommand.linearX.toFixed(2)} · wz=
          {state.manualCommand.angularZ.toFixed(2)}
        </p>
        <p className="nav-legacy-text">{state.lastStatus}</p>
      </div>
      <ManualControlSidebarPanel runtime={runtime} />
      <CameraSidebarPanel runtime={runtime} />
    </div>
  );
}

function ManualControlSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [state, setState] = useState<NavigationState>(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Sliders</h3>
        <label className="range-row">
          Linear speed (m/s): {state.manualLinearSpeed.toFixed(2)}
          <input
            type="range"
            min={1.0}
            max={4.0}
            step={0.01}
            value={state.manualLinearSpeed}
            onChange={(event) => service.setManualLinearSpeed(Number(event.target.value))}
          />
        </label>
        <label className="range-row">
          Angular speed (rad/s): {state.manualAngularSpeed.toFixed(2)}
          <input
            type="range"
            min={0.1}
            max={1.2}
            step={0.01}
            value={state.manualAngularSpeed}
            onChange={(event) => service.setManualAngularSpeed(Number(event.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

function CameraSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);

  const pan = async (angleDeg: number): Promise<void> => {
    try {
      await service.panCamera(angleDeg);
    } catch {}
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Camera PTZ</h3>
        <div className="ptz-grid">
          <button type="button" onClick={() => void pan(45)}>
            ⇖
          </button>
          <button type="button" onClick={() => void pan(0)}>
            ⇑
          </button>
          <button type="button" onClick={() => void pan(-45)}>
            ⇗
          </button>
          <button type="button" onClick={() => void pan(90)}>
            ⇐
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await service.toggleCameraZoom();
              } catch {}
            }}
          >
            🔍
          </button>
          <button type="button" onClick={() => void pan(-90)}>
            ⇒
          </button>
          <button type="button" onClick={() => void pan(135)}>
            ⇙
          </button>
          <button type="button" onClick={() => void pan(180)}>
            ⇓
          </button>
          <button type="button" onClick={() => void pan(-135)}>
            ⇘
          </button>
        </div>
      </div>
    </div>
  );
}

function snapshotExtFromMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

function SnapshotModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [navigation, setNavigation] = useState<NavigationState>(service.getState());
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(service.getState().lastSnapshot);
  const [status, setStatus] = useState("No snapshot loaded.");
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
      setStatus(`Snapshot loaded (${new Date(next.stamp).toLocaleString()})`);
    } catch (error) {
      setStatus(`Snapshot error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const download = (): void => {
    const snapshotToDownload = snapshot ?? service.getState().lastSnapshot;
    if (!snapshotToDownload || typeof window === "undefined") return;
    const mime = snapshotToDownload.mime || "image/png";
    const ext = snapshotExtFromMime(mime);
    const link = window.document.createElement("a");
    link.href = `data:${mime};base64,${snapshotToDownload.imageBase64}`;
    link.download = `nav_snapshot_${snapshotToDownload.stamp}.${ext}`;
    link.click();
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
      <p className="muted">{status}</p>
      <p className="muted">Esc: close · Shift+Esc: download + close</p>
    </div>
  );
}

function InfoModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const telemetryService = getTelemetryService(runtime);
  const sensorInfoService = runtime.registries.serviceRegistry.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  const [state, setState] = useState(sensorInfoService.getState());
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );

  useEffect(() => sensorInfoService.subscribe((next) => setState(next)), [sensorInfoService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetry(next));
  }, [telemetryService]);

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
  const activeInterval = state.intervals[state.activeTab];
  const activeLoading = state.loading[state.activeTab];
  const topicRows = state.topics.catalog.filter((entry) =>
    entry.name.toLowerCase().includes(state.topics.search.trim().toLowerCase())
  );

  return (
    <div className="stack">
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
      <div className="row">
        <label className="grow">
          Refresh (s)
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
      {activeError ? <div className="status-pill bad">Error: {activeError}</div> : null}
      {activeLoading ? <div className="status-pill">Loading...</div> : null}
      {state.activeTab === "general" ? (
        <div className="info-grid-ui">
          <div className="panel-card">
            <strong>Robot mode</strong>
            <p className="muted">{telemetry?.robotStatus.mode ?? "unknown"}</p>
          </div>
          <div className="panel-card">
            <strong>Battery</strong>
            <p className="muted">{telemetry ? `${Number(telemetry.robotStatus.batteryPct).toFixed(1)}%` : "n/a"}</p>
          </div>
          <div className="panel-card">
            <strong>RTK Source</strong>
            <p className="muted">
              {String(
                (activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_label ?? "n/a"
              )}
            </p>
          </div>
        </div>
      ) : null}
      {state.activeTab === "topics" ? (
        <div className="stack">
          <input
            value={state.topics.search}
            onChange={(event) => sensorInfoService.setTopicSearch(event.target.value)}
            placeholder="Buscar topic..."
          />
          <div className="feed-grid">
            <ul className="feed-list">
              {topicRows.map((entry) => (
                <li key={entry.name} className="feed-item">
                  <button
                    type="button"
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
            <div className="panel-card">
              <strong>{state.topics.selectedTopic || "Topics stream"}</strong>
              <pre className="code-block">{state.topics.historyText || "Selecciona un topic."}</pre>
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
      {state.activeTab === "pixhawk_gps" ? (
        <div className="panel-card">
          <strong>Pixhawk/GPS</strong>
          <div className="key-value-grid">
            <span>Fix</span>
            <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.fix_type_name ?? "n/a")}</span>
            <span>Satellites</span>
            <span>
              {String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.satellites_visible ?? "n/a")}
            </span>
            <span>RTK status</span>
            <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.rtk_status ?? "n/a")}</span>
          </div>
        </div>
      ) : null}
      {state.activeTab === "lidar" ? (
        <div className="panel-card">
          <strong>LiDAR</strong>
          <p className="muted">
            {state.implemented.lidar ? "LiDAR telemetry available" : "No LiDAR stream attached in this environment."}
          </p>
        </div>
      ) : null}
      {state.activeTab === "camera" ? (
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
  ctx.registries.transportRegistry.registerTransport({
    id: transport.id,
    order: 10,
    transport
  });
}

function registerDispatcher(ctx: ModuleContext): RobotDispatcher {
  const dispatcher = new RobotDispatcher(DISPATCHER_ID, TRANSPORT_ID);
  ctx.registries.dispatcherRegistry.registerDispatcher({
    id: dispatcher.id,
    order: 10,
    dispatcher
  });
  return dispatcher;
}

function registerServices(ctx: ModuleContext, dispatcher: RobotDispatcher): NavigationService {
  const navigationService = new NavigationService(dispatcher);
  ctx.registries.serviceRegistry.registerService({
    id: NAVIGATION_SERVICE_ID,
    order: 10,
    service: navigationService
  });

  const connectionService = new ConnectionService(ctx.transportManager, ctx.env, TRANSPORT_ID, ctx.eventBus);
  ctx.registries.serviceRegistry.registerService({
    id: CONNECTION_SERVICE_ID,
    order: 11,
    service: connectionService
  });

  const sensorInfoService = new SensorInfoService(dispatcher);
  ctx.registries.serviceRegistry.registerService({
    id: SENSOR_INFO_SERVICE_ID,
    order: 12,
    service: sensorInfoService
  });

  return navigationService;
}

function registerSidebarPanels(ctx: ModuleContext): void {
  ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
    id: "sidebar.connection",
    label: "Connection",
    order: 5,
    render: (runtime) => <ConnectionSidebarPanel runtime={runtime} />
  });
  ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
    id: "sidebar.navigation",
    label: "Navigation",
    order: 6,
    render: (runtime) => <NavigationSidebarPanel runtime={runtime} />
  });
}

function registerModals(ctx: ModuleContext): void {
  ctx.registries.modalRegistry.registerModalDialog({
    id: "modal.snapshot",
    title: "Navigation Snapshot",
    order: 5,
    render: ({ runtime }) => <SnapshotModal runtime={runtime} />
  });
  ctx.registries.modalRegistry.registerModalDialog({
    id: "modal.info",
    title: "Info",
    order: 6,
    render: ({ runtime }) => <InfoModal runtime={runtime} />
  });
}

function registerToolbarMenu(ctx: ModuleContext, navigationService: NavigationService): void {
  ctx.registries.toolbarMenuRegistry.registerToolbarMenu({
    id: "toolbar.navigation",
    label: "Navigation",
    order: 20,
    items: [
      {
        id: "navigation.send-test-goal",
        label: "Send test goal",
        onSelect: async () => {
          try {
            await navigationService.sendGoal({ x: 1.0, y: 2.0, yawDeg: 90 });
            ctx.eventBus.emit("console.event", {
              level: "info",
              text: "Navigation goal sent",
              timestamp: Date.now()
            });
          } catch (error) {
            ctx.eventBus.emit("console.event", {
              level: "error",
              text: `Navigation goal failed: ${String(error)}`,
              timestamp: Date.now()
            });
          }
        }
      },
      {
        id: "navigation.toggle-goal-mode",
        label: "Toggle goal mode",
        onSelect: () => {
          const enabled = navigationService.toggleGoalMode();
          ctx.eventBus.emit("console.event", {
            level: "info",
            text: enabled ? "Goal mode enabled" : "Goal mode disabled",
            timestamp: Date.now()
          });
        }
      },
      {
        id: "navigation.swap-workspace",
        label: "Swap camera/map",
        onSelect: () => {
          ctx.eventBus.emit(NAV_EVENTS.swapWorkspaceRequest, {});
        }
      },
      {
        id: "navigation.open-snapshot-modal",
        label: "Open snapshot modal",
        onSelect: ({ openModal }) => {
          openModal("modal.snapshot");
        }
      },
      {
        id: "navigation.open-info-modal",
        label: "Open info modal",
        onSelect: ({ openModal }) => {
          openModal("modal.info");
        }
      },
      {
        id: "navigation.notify",
        label: "Notify status",
        onSelect: async () => {
          await notify("Cockpit", "Navigation module online");
        }
      }
    ]
  });
}

export function createNavigationModule(): CockpitModule {
  return {
    id: "navigation",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      registerTransport(ctx);
      const dispatcher = registerDispatcher(ctx);
      const navigationService = registerServices(ctx, dispatcher);
      registerSidebarPanels(ctx);
      registerModals(ctx);
      registerToolbarMenu(ctx, navigationService);
    }
  };
}

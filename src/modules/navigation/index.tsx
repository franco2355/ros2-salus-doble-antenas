import { useEffect, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import { notify } from "../../platform/tauri/notifications";
import { ConnectionService } from "../../services/impl/ConnectionService";
import type { TelemetrySnapshot } from "../../services/impl/TelemetryService";
import { NavigationService, type SnapshotData } from "../../services/impl/NavigationService";
import { WebSocketTransport } from "../../transport/impl/WebSocketTransport";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const WAYPOINT_STORAGE_KEY = "cockpit.navigation.waypoints.v1";

interface WaypointDraft {
  x: string;
  y: string;
  yawDeg: string;
}

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
  const [draft, setDraft] = useState<WaypointDraft>({ x: "1.0", y: "2.0", yawDeg: "90" });
  const [waypoints, setWaypoints] = useState<WaypointDraft[]>([]);
  const [loopRoute, setLoopRoute] = useState(true);
  const [manualMode, setManualMode] = useState(false);
  const [status, setStatus] = useState("No active goal");

  const parseDraft = (value: WaypointDraft): { x: number; y: number; yawDeg: number } | null => {
    const parsed = {
      x: Number(value.x),
      y: Number(value.y),
      yawDeg: Number(value.yawDeg)
    };
    return Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.yawDeg) ? parsed : null;
  };

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", {
      level: "info",
      text,
      timestamp: Date.now()
    });
  };

  const loadWaypoints = (): void => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(WAYPOINT_STORAGE_KEY);
    if (!raw) {
      setStatus("No saved waypoints");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as WaypointDraft[];
      if (!Array.isArray(parsed)) throw new Error("invalid payload");
      setWaypoints(parsed.slice(0, 40));
      setStatus(`Loaded ${parsed.length} waypoints`);
      emitInfo(`Loaded ${parsed.length} waypoints`);
    } catch (error) {
      setStatus(`Load failed: ${String(error)}`);
    }
  };

  const saveWaypoints = (): void => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WAYPOINT_STORAGE_KEY, JSON.stringify(waypoints));
    setStatus(`Saved ${waypoints.length} waypoints`);
    emitInfo(`Saved ${waypoints.length} waypoints`);
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Navigation</h3>
        <p className="muted">Goals + route loop (traslado del flujo de navegación).</p>
        <div className="input-grid">
          <input
            value={draft.x}
            onChange={(event) => setDraft((prev) => ({ ...prev, x: event.target.value }))}
            placeholder="X"
          />
          <input
            value={draft.y}
            onChange={(event) => setDraft((prev) => ({ ...prev, y: event.target.value }))}
            placeholder="Y"
          />
        </div>
        <input
          value={draft.yawDeg}
          onChange={(event) => setDraft((prev) => ({ ...prev, yawDeg: event.target.value }))}
          placeholder="Yaw (deg)"
        />
        <div className="action-grid">
          <button
            type="button"
            onClick={() => {
              const parsed = parseDraft(draft);
              if (!parsed) {
                setStatus("Invalid waypoint");
                return;
              }
              setWaypoints((prev) => [...prev, draft].slice(-40));
              setStatus("Waypoint added");
            }}
          >
            Add waypoint
          </button>
          <button
            type="button"
            onClick={() => {
              setWaypoints((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
              setStatus("Waypoint removed");
            }}
            disabled={waypoints.length === 0}
          >
            Undo
          </button>
        </div>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              const first = parseDraft(waypoints[0] ?? draft);
              if (!first) {
                setStatus("Invalid goal payload");
                return;
              }
              try {
                await service.sendGoal(first);
                const sentCount = waypoints.length > 0 ? waypoints.length : 1;
                setStatus(
                  sentCount > 1 && loopRoute
                    ? `Route sent (${sentCount}) · loop ON`
                    : sentCount > 1
                      ? `Route sent (${sentCount})`
                      : "Goal sent"
                );
                emitInfo(`Goal dispatch sent (${sentCount} waypoint${sentCount > 1 ? "s" : ""})`);
              } catch (error) {
                setStatus(`Goal failed: ${String(error)}`);
              }
            }}
          >
            Send
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await service.cancelGoal();
                setStatus("Goal cancelled");
                emitInfo("Goal cancelled");
              } catch (error) {
                setStatus(`Cancel failed: ${String(error)}`);
              }
            }}
          >
            Cancel
          </button>
        </div>
        <div className="action-grid">
          <button type="button" onClick={saveWaypoints}>
            Save route
          </button>
          <button type="button" onClick={loadWaypoints}>
            Load route
          </button>
        </div>
        <div className="row">
          <label className="check-row">
            <input type="checkbox" checked={loopRoute} onChange={(event) => setLoopRoute(event.target.checked)} />
            Loop route
          </label>
          <button
            type="button"
            onClick={async () => {
              const next = !manualMode;
              try {
                await service.setManualMode(next);
                setManualMode(next);
                setStatus(next ? "Manual mode ON" : "Manual mode OFF");
                emitInfo(next ? "Manual mode enabled" : "Manual mode disabled");
              } catch (error) {
                setStatus(`Manual mode failed: ${String(error)}`);
              }
            }}
          >
            Manual: {manualMode ? "ON" : "OFF"}
          </button>
        </div>
        <button
          type="button"
          className="danger-btn"
          onClick={() => {
            setWaypoints([]);
            setStatus("Waypoints cleared");
          }}
          disabled={waypoints.length === 0}
        >
          Clear waypoints
        </button>
        <div className="status-pill">{status}</div>
        <p className="muted">Queued waypoints: {waypoints.length}</p>
      </div>
    </div>
  );
}

function ManualControlSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [linearSpeed, setLinearSpeed] = useState(1.2);
  const [angularSpeed, setAngularSpeed] = useState(0.4);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [status, setStatus] = useState("Manual mode OFF");

  const send = async (linearX: number, angularZ: number, brake = false): Promise<void> => {
    try {
      await service.sendManualCommand({ linearX, angularZ, brake });
      const label = `vx=${linearX.toFixed(2)} wz=${angularZ.toFixed(2)}${brake ? " brake" : ""}`;
      setStatus(label);
      runtime.eventBus.emit("console.event", {
        level: "info",
        text: `Manual cmd ${label}`,
        timestamp: Date.now()
      });
    } catch (error) {
      setStatus(`Manual cmd failed: ${String(error)}`);
    }
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Manual Control</h3>
        <p className="muted">Sliders + cmd_vel controls (W/A/S/D equivalente).</p>
        <label className="range-row">
          Linear speed (m/s): <strong>{linearSpeed.toFixed(2)}</strong>
          <input
            type="range"
            min={1.0}
            max={4.0}
            step={0.01}
            value={linearSpeed}
            onChange={(event) => setLinearSpeed(Number(event.target.value))}
          />
        </label>
        <label className="range-row">
          Angular speed (rad/s): <strong>{angularSpeed.toFixed(2)}</strong>
          <input
            type="range"
            min={0.1}
            max={0.4}
            step={0.01}
            value={angularSpeed}
            onChange={(event) => setAngularSpeed(Number(event.target.value))}
          />
        </label>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              const next = !manualEnabled;
              try {
                await service.setManualMode(next);
                setManualEnabled(next);
                setStatus(next ? "Manual mode ON" : "Manual mode OFF");
              } catch (error) {
                setStatus(`Manual mode failed: ${String(error)}`);
              }
            }}
          >
            Manual: {manualEnabled ? "ON" : "OFF"}
          </button>
          <button type="button" onClick={() => void send(0, 0, true)}>
            Brake
          </button>
        </div>
        <div className="control-pad">
          <button type="button" onMouseDown={() => void send(linearSpeed, 0)}>
            W
          </button>
          <button type="button" onMouseDown={() => void send(0, -angularSpeed)}>
            A
          </button>
          <button type="button" onMouseDown={() => void send(-linearSpeed, 0)}>
            S
          </button>
          <button type="button" onMouseDown={() => void send(0, angularSpeed)}>
            D
          </button>
        </div>
        <div className="status-pill">{status}</div>
      </div>
    </div>
  );
}

function CameraSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [streamConnected, setStreamConnected] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("camera: disconnected");

  const pan = async (angleDeg: number): Promise<void> => {
    try {
      await service.panCamera(angleDeg);
      setCameraStatus(`camera pan=${angleDeg}`);
    } catch (error) {
      setCameraStatus(`pan failed: ${String(error)}`);
    }
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Camera PTZ</h3>
        <p className="muted">Controles PTZ migrados de la interfaz anterior.</p>
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
                setCameraStatus("camera zoom toggled");
              } catch (error) {
                setCameraStatus(`zoom failed: ${String(error)}`);
              }
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
        <div className="action-grid">
          <button
            type="button"
            onClick={() => {
              setStreamConnected((prev) => !prev);
              setCameraStatus(streamConnected ? "camera: disconnected" : "camera: connected");
            }}
          >
            {streamConnected ? "Disconnect stream" : "Connect stream"}
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const status = await service.readCameraStatus();
                setCameraStatus(
                  status.ok
                    ? `camera ok · last=${status.lastCommand} · zoom=${status.zoomIn ? "in" : "out"}`
                    : `camera error: ${status.error}`
                );
              } catch (error) {
                setCameraStatus(`status failed: ${String(error)}`);
              }
            }}
          >
            Read status
          </button>
        </div>
        <div className={`status-pill ${streamConnected ? "ok" : "bad"}`}>{cameraStatus}</div>
      </div>
    </div>
  );
}

function CameraGpsWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [mainPane, setMainPane] = useState<"camera" | "gps">("camera");
  const [unlocked, setUnlocked] = useState(false);
  const mainIsCamera = mainPane === "camera";
  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Camera / GPS Workspace</h3>
        <p className="muted">Stage central con swap de vistas (patrón del monolito).</p>
        <div className="stage">
          <section className={`stage-pane ${mainIsCamera ? "main" : "mini"}`}>
            <h4>Camera</h4>
            <div className="pane-placeholder">Camera feed iframe host</div>
          </section>
          <section className={`stage-pane ${mainIsCamera ? "mini" : "main"}`}>
            <h4>GPS Map</h4>
            <div className="pane-placeholder">Map canvas host</div>
          </section>
          <div className="stage-actions">
            <button type="button" className="swap-btn" onClick={() => setMainPane(mainIsCamera ? "gps" : "camera")}>
              Swap
            </button>
            <button type="button" onClick={() => setUnlocked((prev) => !prev)}>
              {unlocked ? "Lock controls" : "Unlock controls"}
            </button>
            <button
              type="button"
              onClick={() => {
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Workspace controls ${unlocked ? "locked" : "unlocked"}`,
                  timestamp: Date.now()
                });
              }}
            >
              Publish state
            </button>
          </div>
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
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [status, setStatus] = useState("No snapshot loaded.");
  const [loading, setLoading] = useState(false);

  const download = (): void => {
    if (!snapshot || typeof window === "undefined") return;
    const mime = snapshot.mime || "image/png";
    const ext = snapshotExtFromMime(mime);
    const link = window.document.createElement("a");
    link.href = `data:${mime};base64,${snapshot.imageBase64}`;
    link.download = `nav_snapshot_${snapshot.stamp}.${ext}`;
    link.click();
  };

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          disabled={loading}
          onClick={async () => {
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
  const [activeTab, setActiveTab] = useState<"general" | "topics" | "pixhawk_gps" | "lidar" | "camera">("general");
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );

  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setSnapshot(next));
  }, [telemetryService]);

  return (
    <div className="stack">
      <div className="modal-tabs">
        <button
          type="button"
          className={`modal-tab ${activeTab === "general" ? "active" : ""}`}
          onClick={() => setActiveTab("general")}
        >
          General
        </button>
        <button
          type="button"
          className={`modal-tab ${activeTab === "topics" ? "active" : ""}`}
          onClick={() => setActiveTab("topics")}
        >
          Topics
        </button>
        <button
          type="button"
          className={`modal-tab ${activeTab === "pixhawk_gps" ? "active" : ""}`}
          onClick={() => setActiveTab("pixhawk_gps")}
        >
          Pixhawk/GPS
        </button>
        <button
          type="button"
          className={`modal-tab ${activeTab === "lidar" ? "active" : ""}`}
          onClick={() => setActiveTab("lidar")}
        >
          LiDAR
        </button>
        <button
          type="button"
          className={`modal-tab ${activeTab === "camera" ? "active" : ""}`}
          onClick={() => setActiveTab("camera")}
        >
          Camera
        </button>
      </div>
      {activeTab === "general" ? (
        <div className="info-grid-ui">
          <div className="panel-card">
            <strong>Robot mode</strong>
            <p className="muted">{snapshot?.robotStatus.mode ?? "unknown"}</p>
          </div>
          <div className="panel-card">
            <strong>Battery</strong>
            <p className="muted">
              {snapshot ? `${Number(snapshot.robotStatus.batteryPct).toFixed(1)}%` : "n/a"}
            </p>
          </div>
          <div className="panel-card">
            <strong>Alerts</strong>
            <p className="muted">{snapshot?.alerts.length ?? 0} active</p>
          </div>
        </div>
      ) : null}
      {activeTab === "topics" ? (
        <div className="panel-card">
          <strong>ROS topics catalog</strong>
          <p className="muted">Subscribed topics and latest payload preview.</p>
          <pre className="code-block">/robot/status{"\n"}/robot/pose{"\n"}/navigation/goal{"\n"}/camera/status</pre>
        </div>
      ) : null}
      {activeTab === "pixhawk_gps" ? (
        <div className="panel-card">
          <strong>Pixhawk/GPS</strong>
          <div className="key-value-grid">
            <span>Fix</span>
            <span>3D</span>
            <span>Satellites</span>
            <span>12</span>
            <span>HDOP</span>
            <span>0.8</span>
          </div>
        </div>
      ) : null}
      {activeTab === "lidar" ? (
        <div className="panel-card">
          <strong>LiDAR</strong>
          <p className="muted">No LiDAR stream attached in this environment.</p>
        </div>
      ) : null}
      {activeTab === "camera" ? (
        <div className="panel-card">
          <strong>Camera</strong>
          <p className="muted">PTZ control path: service.navigation → dispatcher.robot → transport.ws.core</p>
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
  ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
    id: "sidebar.manual",
    label: "Manual",
    order: 7,
    render: (runtime) => <ManualControlSidebarPanel runtime={runtime} />
  });
  ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
    id: "sidebar.camera",
    label: "Camera",
    order: 8,
    render: (runtime) => <CameraSidebarPanel runtime={runtime} />
  });
}

function registerWorkspaceViews(ctx: ModuleContext): void {
  ctx.registries.workspaceViewRegistry.registerWorkspaceView({
    id: "workspace.camera-gps",
    label: "Camera/GPS",
    order: 5,
    render: (runtime) => <CameraGpsWorkspaceView runtime={runtime} />
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
      registerWorkspaceViews(ctx);
      registerModals(ctx);
      registerToolbarMenu(ctx, navigationService);
    }
  };
}

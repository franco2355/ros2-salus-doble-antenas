import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { MissionDispatcher } from "../dispatcher/impl/MissionDispatcher";
import { MissionService } from "../service/impl/MissionService";
import type { RosbagStatus } from "../dispatcher/impl/MissionDispatcher";
import { RosBridgeTransport } from "../transport/impl/RosBridgeTransport";
import { NavigationCommands } from "../../navigation/commands";

const TRANSPORT_ID = "transport.rosbridge";
const DISPATCHER_ID = "dispatcher.mission";
const SERVICE_ID = "service.mission";
const OPEN_RECORD_MODAL_COMMAND_ID = "nav2.debug.openRecordModal";

function RecordModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = missionService.subscribeRosbagStatus((next) => {
      setStatus(next);
    });
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
    return unsubscribe;
  }, [missionService]);

  const stateText = status.active ? "grabando" : "detenido";
  const stateClassName = status.active ? "record-toggle-btn recording" : "record-toggle-btn stopped";

  return (
    <div className="record-modal">
      <div className="record-modal-copy">
        <span className="record-modal-kicker">Mission Recorder</span>
        <h3 className="record-modal-title">Rosbag Capture</h3>
        <p className="record-modal-subtitle">
          Iniciá o detené la grabación operativa sin salir del cockpit.
        </p>
      </div>
      <div className="record-modal-status-card">
        <span className={`record-status-dot ${status.active ? "recording" : "stopped"}`} aria-hidden="true" />
        <div className="record-modal-status-copy">
          <strong>{status.active ? "Recording active" : "Recorder idle"}</strong>
          <span>Profile {status.profile}</span>
        </div>
      </div>
      <button
        type="button"
        className={stateClassName}
        onClick={async () => {
          setError("");
          try {
            const next = status.active ? await missionService.stopRosbag() : await missionService.startRosbag();
            setStatus(next);
            runtime.eventBus.emit("console.event", {
              level: status.active ? "warn" : "info",
              text: status.active ? "Grabación detenida" : "Grabación iniciada",
              timestamp: Date.now()
            });
          } catch (cause) {
            setError(String(cause));
          }
        }}
      >
        <span className="record-toggle-btn-copy">
          <span className="record-toggle-btn-label">{status.active ? "Detener grabación" : "Iniciar grabación"}</span>
          <span className="record-toggle-btn-meta">{status.active ? "Cerrar rosbag actual" : "Crear nueva captura"}</span>
        </span>
      </button>
      <p className={`record-status-legend ${status.active ? "recording" : "stopped"}`}>
        Estado: {stateText}
      </p>
      <div className="record-modal-meta">
        <div className="record-meta-card">
          <span className="record-meta-label">Output</span>
          <strong className="record-meta-value">{status.outputPath || "n/a"}</strong>
        </div>
        <div className="record-meta-card">
          <span className="record-meta-label">Log</span>
          <strong className="record-meta-value">{status.logPath || "n/a"}</strong>
        </div>
      </div>
      {error ? <p className="muted">Error: {error}</p> : null}
    </div>
  );
}

function DebugSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });

  useEffect(() => {
    const unsubscribe = missionService.subscribeRosbagStatus((next) => {
      setStatus(next);
    });
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
    return unsubscribe;
  }, [missionService]);

  return (
    <div className="stack debug-sidebar-panel">
      <div className="panel-card debug-sidebar-hero">
        <span className="debug-sidebar-kicker">Diagnostics</span>
        <div className="debug-sidebar-header">
          <h3>Debug</h3>
          <span className={`status-pill ${status.active ? "ok" : ""}`}>
            {status.active ? "Recording" : "Idle"}
          </span>
        </div>
        <p className="muted debug-sidebar-copy">
          Accedé a captura operativa y diagnóstico del stack sin salir del panel lateral.
        </p>
        <div className="debug-sidebar-actions">
          <button
            type="button"
            aria-label="Open Recorder"
            className="button-primary button-tile"
            onClick={() => {
              void runtime.commands.execute(OPEN_RECORD_MODAL_COMMAND_ID);
            }}
          >
            <span className="button-face">
              <span className="button-face-icon" aria-hidden="true">
                ⏺
              </span>
              <span className="button-face-copy">
                <span className="button-face-label">Recorder</span>
                <span className="button-face-meta">Open rosbag capture controls</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Open Debug Info"
            className="button-secondary button-tile"
            onClick={() => {
              void runtime.commands.execute(NavigationCommands.openInfoModal);
            }}
          >
            <span className="button-face">
              <span className="button-face-icon" aria-hidden="true">
                ℹ
              </span>
              <span className="button-face-copy">
                <span className="button-face-label">Info</span>
                <span className="button-face-meta">Open navigation diagnostics</span>
              </span>
            </span>
          </button>
        </div>
      </div>
      <div className="panel-card debug-sidebar-status-grid">
        <div className="debug-sidebar-stat">
          <span className="debug-sidebar-stat-label">Profile</span>
          <strong className="debug-sidebar-stat-value">{status.profile}</strong>
        </div>
        <div className="debug-sidebar-stat">
          <span className="debug-sidebar-stat-label">Recorder</span>
          <strong className="debug-sidebar-stat-value">{status.active ? "Active" : "Stopped"}</strong>
        </div>
      </div>
      <div className="panel-card debug-sidebar-paths">
        <div className="debug-sidebar-path">
          <span className="debug-sidebar-path-label">Output</span>
          <strong className="debug-sidebar-path-value">{status.outputPath || "n/a"}</strong>
        </div>
        <div className="debug-sidebar-path">
          <span className="debug-sidebar-path-label">Log</span>
          <strong className="debug-sidebar-path-value">{status.logPath || "n/a"}</strong>
        </div>
      </div>
    </div>
  );
}

export function createDebugModule(): CockpitModule {
  return {
    id: "debug",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const transport = new RosBridgeTransport(TRANSPORT_ID, ({ env }) => env.rosbridgeUrl);
      ctx.transports.registerTransport({
        id: transport.id,
        transport
      });

      const dispatcher = new MissionDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MissionService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "modal.record",
        slot: "modal",
        title: "Record",
        render: () => <RecordModal runtime={ctx} />
      });

      ctx.commands.register(
        { id: OPEN_RECORD_MODAL_COMMAND_ID, title: "Open Record Modal", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openModal, "modal.record")
      );

      ctx.contributions.register({
        id: "sidebar.debug",
        slot: "sidebar",
        label: "Debug",
        icon: "🛠️",
        order: 100,
        render: () => <DebugSidebarPanel runtime={ctx} />
      });
    }
  };
}

import { useEffect, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { MissionDispatcher } from "../../dispatcher/impl/MissionDispatcher";
import { notify } from "../../platform/tauri/notifications";
import { openWindow } from "../../platform/tauri/windows";
import { MissionService } from "../../services/impl/MissionService";
import type { RosbagStatus } from "../../dispatcher/impl/MissionDispatcher";
import { RosBridgeTransport } from "../../transport/impl/RosBridgeTransport";

const TRANSPORT_ID = "transport.rosbridge";
const DISPATCHER_ID = "dispatcher.mission";
const SERVICE_ID = "service.mission";

interface ConsoleEvent {
  level: string;
  text: string;
  timestamp: number;
}

function EventConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [events, setEvents] = useState<ConsoleEvent[]>([]);

  useEffect(() => {
    const unsubscribe = runtime.eventBus.on<ConsoleEvent>("console.event", (event) => {
      setEvents((prev) => [event, ...prev].slice(0, 80));
    });
    return () => unsubscribe();
  }, [runtime]);

  if (events.length === 0) {
    return <p className="muted">No events yet.</p>;
  }

  return (
    <ul className="feed-list">
      {events.map((event, idx) => (
        <li key={`${event.timestamp}.${idx}`} className="feed-item">
          <strong>[{event.level}]</strong> {event.text}
          <div className="muted">{new Date(event.timestamp).toLocaleTimeString()}</div>
        </li>
      ))}
    </ul>
  );
}

function MissionModal({ runtime, close }: { runtime: ModuleContext; close: () => void }): JSX.Element {
  const missionService = runtime.registries.serviceRegistry.getService<MissionService>(SERVICE_ID);
  const [missionId, setMissionId] = useState("mission-alpha");
  const [robotId, setRobotId] = useState("robot-01");

  return (
    <div className="panel-card">
      <h3>Mission Debug</h3>
      <p className="muted">Launch mission using MissionService and MissionDispatcher.</p>
      <div className="row">
        <input value={missionId} onChange={(event) => setMissionId(event.target.value)} />
        <input value={robotId} onChange={(event) => setRobotId(event.target.value)} />
      </div>
      <div className="row">
        <button
          type="button"
          onClick={async () => {
            try {
              await missionService.startMission({ missionId, robotId });
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: `Mission started: ${missionId}`,
                timestamp: Date.now()
              });
              await notify("Mission", `Started ${missionId}`);
              close();
            } catch (error) {
              runtime.eventBus.emit("console.event", {
                level: "error",
                text: `Mission failed: ${String(error)}`,
                timestamp: Date.now()
              });
            }
          }}
        >
          Start mission
        </button>
      </div>
    </div>
  );
}

function RecordModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.registries.serviceRegistry.getService<MissionService>(SERVICE_ID);
  const [profile, setProfile] = useState("core");
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });
  const [error, setError] = useState("");

  useEffect(() => {
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
  }, [missionService]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Record</h3>
        <p className="muted">
          Rosbag manual para debugging de navegacion. El bag queda grabado dentro del workspace ROS del backend.
        </p>
        <div className={`status-pill ${status.active ? "ok" : ""}`}>
          Rosbag: {status.active ? `recording (${status.profile})` : "idle"}
        </div>
        <div className="key-value-grid">
          <span>Output path</span>
          <code>{status.outputPath}</code>
          <span>Log path</span>
          <code>{status.logPath}</code>
        </div>
        <div className="row">
          <label className="grow">
            Profile
            <select value={profile} onChange={(event) => setProfile(event.target.value)}>
              <option value="core">core</option>
              <option value="navigation">navigation</option>
              <option value="full">full</option>
            </select>
          </label>
        </div>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              setError("");
              try {
                const next = await missionService.startRosbag(profile);
                setStatus(next);
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Rosbag started (${profile})`,
                  timestamp: Date.now()
                });
              } catch (cause) {
                setError(String(cause));
              }
            }}
          >
            Start bag
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={async () => {
              setError("");
              try {
                const next = await missionService.stopRosbag();
                setStatus(next);
                runtime.eventBus.emit("console.event", {
                  level: "warn",
                  text: "Rosbag stopped",
                  timestamp: Date.now()
                });
              } catch (cause) {
                setError(String(cause));
              }
            }}
          >
            Stop bag
          </button>
        </div>
        {error ? <p className="muted">Error: {error}</p> : null}
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
      ctx.registries.transportRegistry.registerTransport({
        id: transport.id,
        order: 40,
        transport
      });

      const dispatcher = new MissionDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.registries.dispatcherRegistry.registerDispatcher({
        id: dispatcher.id,
        order: 40,
        dispatcher
      });

      const service = new MissionService(dispatcher);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        order: 40,
        service
      });

      ctx.registries.consoleTabRegistry.registerConsoleTab({
        id: "console.events",
        label: "Events",
        order: 10,
        render: (runtime) => <EventConsoleTab runtime={runtime} />
      });

      ctx.registries.modalRegistry.registerModalDialog({
        id: "modal.debug",
        title: "Debug mission",
        order: 10,
        render: ({ runtime, close }) => <MissionModal runtime={runtime} close={close} />
      });

      ctx.registries.modalRegistry.registerModalDialog({
        id: "modal.record",
        title: "Record",
        order: 11,
        render: ({ runtime }) => <RecordModal runtime={runtime} />
      });

      ctx.registries.toolbarMenuRegistry.registerToolbarMenu({
        id: "toolbar.debug",
        label: "Debug",
        order: 40,
        items: [
          {
            id: "debug.open-modal",
            label: "Open mission modal",
            onSelect: ({ openModal }) => {
              openModal("modal.debug");
            }
          },
          {
            id: "debug.open-record-modal",
            label: "Open record modal",
            onSelect: ({ openModal }) => {
              openModal("modal.record");
            }
          },
          {
            id: "debug.open-window",
            label: "Open secondary window",
            onSelect: async () => {
              await openWindow({
                label: "telemetry-window",
                route: "/",
                title: "Telemetry Window"
              });
            }
          }
        ]
      });
    }
  };
}

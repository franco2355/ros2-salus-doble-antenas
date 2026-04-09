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
        {status.active ? "grabando" : "detenido"}
      </button>
      <p className={`record-status-legend ${status.active ? "recording" : "stopped"}`}>
        Estado: {stateText}
      </p>
      {error ? <p className="muted">Error: {error}</p> : null}
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
        id: "toolbar.debug",
        slot: "toolbar",
        label: "Debug",
        items: [
          {
            id: "debug.open-record-modal",
            label: "Grabación",
            commandId: OPEN_RECORD_MODAL_COMMAND_ID
          },
          {
            id: "debug.open-info-modal",
            label: "Información",
            commandId: NavigationCommands.openInfoModal
          }
        ]
      });
    }
  };
}

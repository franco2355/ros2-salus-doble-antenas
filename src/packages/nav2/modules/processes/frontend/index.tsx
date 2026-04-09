import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import type { ConnectionService, ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { ProcessesCommands } from "../commands";
import { ProcessesDispatcher } from "../dispatcher/impl/ProcessesDispatcher";
import {
  ProcessesService,
  type ProcessStatus,
  type ProcessViewState,
  type ProcessesState
} from "../service/impl/ProcessesService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.processes";
const SERVICE_ID = "service.processes";
const CONNECTION_SERVICE_ID = "service.connection";

function statusText(status: ProcessStatus): string {
  if (status === "running") return "En ejecución";
  if (status === "success") return "Terminado (OK)";
  if (status === "error") return "Terminado (ERROR)";
  return "Inactivo";
}

function buttonStatusClass(status: ProcessStatus): string {
  if (status === "running") return "process-status-running";
  if (status === "success") return "process-status-success";
  if (status === "error") return "process-status-error";
  return "process-status-idle";
}

function ProcessesModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<ProcessesService>(SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }

  const [state, setState] = useState<ProcessesState>(service.getState());
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);
  useEffect(() => {
    void service.open().catch(() => undefined);
    return () => {
      service.close();
    };
  }, [service]);

  const connected = connectionState ? connectionState.connected : true;
  const visibleProcesses = state.processes.filter((entry) =>
    entry.label.toLowerCase().includes(state.search.trim().toLowerCase())
  );
  const selected =
    state.processes.find((entry) => entry.label === state.selectedProcess) ??
    visibleProcesses[0] ??
    null;
  const actionLabel = selected?.running ? "Detener" : "Ejecutar";

  return (
    <div className="process-modal-root">
      {state.error ? <div className="status-pill bad">{state.error}</div> : null}
      {!connected ? (
        <div className="panel-card info-placeholder-card">
          <strong>Processes</strong>
          <p className="muted">Conecta WebSocket para consultar procesos.</p>
        </div>
      ) : (
        <div className="process-modal-layout">
          <div className="process-modal-sidebar">
            <input
              value={state.search}
              onChange={(event) => {
                service.setSearch(event.target.value);
              }}
              placeholder="Buscar proceso..."
            />
            <div className="process-modal-sidebar-actions">
              <button
                type="button"
                onClick={() => {
                  void service.refresh().catch((error) => {
                    runtime.eventBus.emit("console.event", {
                      level: "error",
                      text: `Reload processes failed: ${String(error)}`,
                      timestamp: Date.now()
                    });
                  });
                }}
                disabled={state.loading}
              >
                Reload
              </button>
            </div>
            <ul className="process-modal-list">
              {visibleProcesses.map((entry) => (
                <li key={entry.label} className="feed-item">
                  <button
                    type="button"
                    className={`process-modal-process-btn ${buttonStatusClass(entry.status)} ${entry.label === selected?.label ? "active" : ""}`}
                    onClick={() => {
                      service.selectProcess(entry.label);
                    }}
                  >
                    {entry.label}
                  </button>
                  <div className="process-modal-item-meta">{entry.cwd || entry.command || "Sin detalles"}</div>
                </li>
              ))}
              {!state.loading && visibleProcesses.length === 0 ? <li className="feed-item muted">No hay procesos.</li> : null}
              {state.loading ? <li className="feed-item muted">Cargando procesos...</li> : null}
            </ul>
          </div>
          <div className="panel-card process-modal-content">
            {selected ? (
              <>
                <div className="process-modal-header">
                  <strong>{selected.label}</strong>
                  <span className={`process-modal-status ${buttonStatusClass(selected.status)}`}>{statusText(selected.status)}</span>
                </div>
                <div className="process-modal-details">
                  <span className="info-topics-selected-badge">{selected.cwd || "cwd=n/a"}</span>
                  <span className="info-topics-selected-badge">{selected.command || "command=n/a"}</span>
                </div>
                <div className="process-modal-toggle-row">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selected.outputEnabled}
                      disabled={selected.running}
                      onChange={(event) => {
                        service.setOutputEnabled(selected.label, event.target.checked);
                      }}
                    />
                    Reenviar output
                  </label>
                  {selected.running ? <span className="process-modal-toggle-note">Aplica próxima ejecución.</span> : null}
                </div>
                <div className="panel-card process-modal-output-placeholder">
                  <div className="stack">
                    <strong>Características</strong>
                    <span className="muted">Command: {selected.command || "n/a"}</span>
                    <span className="muted">Cwd: {selected.cwd || "n/a"}</span>
                    {selected.lastError ? <span className="status-bad">{selected.lastError}</span> : null}
                  </div>
                </div>
                <div className="row">
                  <button
                    type="button"
                    onClick={() => {
                      const action = selected.running
                        ? service.stopProcess(selected.label)
                        : service.startProcess(selected.label);
                      void action.then(() => {
                        runtime.eventBus.emit("console.event", {
                          level: selected.running ? "warn" : "info",
                          text: selected.running ? `Proceso detenido: ${selected.label}` : `Proceso iniciado: ${selected.label}`,
                          timestamp: Date.now()
                        });
                      }).catch((error) => {
                        runtime.eventBus.emit("console.event", {
                          level: "error",
                          text: `${selected.running ? "Stop" : "Start"} process failed: ${String(error)}`,
                          timestamp: Date.now()
                        });
                      });
                    }}
                  >
                    {actionLabel}
                  </button>
                </div>
              </>
            ) : (
              <div className="panel-card info-placeholder-card">
                <strong>Processes</strong>
                <p className="muted">Selecciona un proceso.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function createProcessesModule(): CockpitModule {
  return {
    id: "processes",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcher = new ProcessesDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new ProcessesService(dispatcher, ctx.eventBus);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "modal.processes",
        slot: "modal",
        title: "Processes",
        render: () => <ProcessesModal runtime={ctx} />
      });

      ctx.commands.register(
        { id: ProcessesCommands.openModal, title: "Open Processes Modal", category: "Processes" },
        () => {
          void ctx.commands.execute(ShellCommands.openModal, "modal.processes");
        }
      );

      ctx.keybindings.register({
        key: "p",
        commandId: ProcessesCommands.openModal,
        source: "default",
        when: "!modalOpen"
      });

      ctx.contributions.register({
        id: "toolbar.processes",
        slot: "toolbar",
        label: "Processes",
        commandId: ProcessesCommands.openModal
      });
    }
  };
}

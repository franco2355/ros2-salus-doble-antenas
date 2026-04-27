import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import type { ConnectionService, ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { ProcessesCommands } from "../commands";
import { ProcessesDispatcher } from "../dispatcher/impl/ProcessesDispatcher";
import { parseAnsiText } from "./ansi";
import {
  ProcessesService,
  type ProcessStatus,
  type ProcessesState
} from "../service/impl/ProcessesService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.processes";
const SERVICE_ID = "service.processes";
const CONNECTION_SERVICE_ID = "service.connection";
const OUTPUT_FOLLOW_THRESHOLD = 24;

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

function statusMetaText(status: ProcessStatus): string {
  if (status === "running") return "Live task";
  if (status === "success") return "Last run ok";
  if (status === "error") return "Needs review";
  return "Ready";
}

function ProcessListButton({
  label,
  status,
  active,
  onSelect
}: {
  label: string;
  status: ProcessStatus;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`process-modal-process-btn ${buttonStatusClass(status)} ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      <span className="process-list-button-copy">
        <span className="process-list-button-label">{label}</span>
        <span className="process-list-button-meta">{statusMetaText(status)}</span>
      </span>
      <span className={`process-list-button-badge ${buttonStatusClass(status)}`}>{statusText(status)}</span>
    </button>
  );
}

export function ProcessesModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
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
  const [outputStream, setOutputStream] = useState<"stdout" | "stderr">("stdout");
  const outputViewportRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const outputKeyRef = useRef("");
  const connected = connectionState ? connectionState.connected : true;
  const visibleProcesses = state.processes.filter((entry) =>
    entry.label.toLowerCase().includes(state.search.trim().toLowerCase())
  );
  const selected =
    state.processes.find((entry) => entry.label === state.selectedProcess) ??
    visibleProcesses[0] ??
    null;
  const actionLabel = selected?.running ? "Detener" : "Ejecutar";
  const selectedOutputRaw = selected ? (outputStream === "stdout" ? selected.stdoutText : selected.stderrText) : "";
  const outputKey = `${selected?.label ?? ""}:${outputStream}`;
  const parsedOutput = useMemo(() => parseAnsiText(selectedOutputRaw), [selectedOutputRaw]);
  const hasOutput = parsedOutput.plainText.length > 0;

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
  useEffect(() => {
    if (!selected) return;
    if (selected.stdoutText) {
      setOutputStream("stdout");
      return;
    }
    if (selected.stderrText) {
      setOutputStream("stderr");
    }
  }, [selected?.label]);
  useEffect(() => {
    if (outputKeyRef.current === outputKey) return;
    outputKeyRef.current = outputKey;
    followOutputRef.current = true;
  }, [outputKey]);
  useLayoutEffect(() => {
    const viewport = outputViewportRef.current;
    if (!viewport || !followOutputRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [outputKey, selectedOutputRaw]);

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
            <div className="process-modal-sidebar-header">
              <span className="process-modal-kicker">Runtime Control</span>
              <h4 className="process-modal-sidebar-title">Managed Processes</h4>
              <p className="muted process-modal-sidebar-copy">
                Seleccioná un proceso para revisar output, estado y controlarlo desde el cockpit.
              </p>
            </div>
            <div className="process-modal-search-row">
              <input
                value={state.search}
                onChange={(event) => {
                  service.setSearch(event.target.value);
                }}
                placeholder="Buscar proceso..."
              />
              <button
                type="button"
                className="process-modal-reload-btn button-secondary"
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
                  <ProcessListButton
                    label={entry.label}
                    status={entry.status}
                    active={entry.label === selected?.label}
                    onSelect={() => {
                      service.selectProcess(entry.label);
                    }}
                  />
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
                  <div className="process-modal-header-copy">
                    <span className="process-modal-kicker">Selected Process</span>
                    <strong>{selected.label}</strong>
                  </div>
                  <span className={`process-modal-status ${buttonStatusClass(selected.status)}`}>{statusText(selected.status)}</span>
                </div>
                <div className="process-modal-details">
                  <span>
                    <strong>CWD:</strong> {selected.cwd || "n/a"}
                  </span>
                  <span>
                    <strong>Process:</strong> {selected.command || "n/a"}
                  </span>
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
                <div className="panel-card process-modal-output-panel">
                  <div className="process-modal-output-header">
                    <span className="process-modal-output-title">Output stream</span>
                    <button
                      type="button"
                      className={`process-modal-output-tab ${outputStream === "stdout" ? "active" : ""}`}
                      onClick={() => {
                        setOutputStream("stdout");
                      }}
                    >
                      stdout
                    </button>
                    <button
                      type="button"
                      className={`process-modal-output-tab ${outputStream === "stderr" ? "active" : ""}`}
                      onClick={() => {
                        setOutputStream("stderr");
                      }}
                    >
                      stderr
                    </button>
                  </div>
                  {hasOutput ? (
                    <div
                      ref={outputViewportRef}
                      className="process-modal-output-text"
                      data-testid="process-output-scroll"
                      onScroll={(event) => {
                        const target = event.currentTarget;
                        const distance = target.scrollHeight - target.clientHeight - target.scrollTop;
                        followOutputRef.current = distance <= OUTPUT_FOLLOW_THRESHOLD;
                      }}
                    >
                      {parsedOutput.segments.map((segment, index) => (
                        <span key={`${outputKey}-${index}`} style={segment.style}>
                          {segment.text}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="process-modal-output-empty muted">Sin output.</div>
                  )}
                  {selected.lastError ? <span className="status-bad">{selected.lastError}</span> : null}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!hasOutput}
                    onClick={() => {
                      const clipboardApi =
                        typeof navigator !== "undefined" && navigator.clipboard
                          ? navigator.clipboard
                          : null;
                      if (!clipboardApi) {
                        runtime.eventBus.emit("console.event", {
                          level: "error",
                          text: "Copy output failed: Clipboard API unavailable",
                          timestamp: Date.now()
                        });
                        return;
                      }
                      void clipboardApi.writeText(parsedOutput.plainText).then(() => {
                        runtime.eventBus.emit("console.event", {
                          level: "info",
                          text: `Output copiado: ${selected.label} (${outputStream})`,
                          timestamp: Date.now()
                        });
                      }).catch((error) => {
                        runtime.eventBus.emit("console.event", {
                          level: "error",
                          text: `Copy output failed: ${String(error)}`,
                          timestamp: Date.now()
                        });
                      });
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className={selected.running ? "danger-btn" : "button-primary"}
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

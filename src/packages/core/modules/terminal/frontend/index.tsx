import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { CORE_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { TerminalService, type TerminalState } from "../service/impl/TerminalService";

const TERMINAL_SERVICE_ID = "service.terminal";

interface CoreRuntimeConfig {
  terminal_ssh_config_path?: unknown;
  terminal_default_host?: unknown;
  terminal_shell_override?: unknown;
  terminal_scrollback?: unknown;
}

interface XTermLike {
  write(data: string): void;
  clear(): void;
  writeln(data: string): void;
  open(container: HTMLElement): void;
  focus(): void;
  dispose(): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  cols: number;
  rows: number;
}

interface FitAddonLike {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

function readCoreConfig(ctx: ModuleContext): CoreRuntimeConfig {
  return ctx.getPackageConfig<Record<string, unknown>>("core") as CoreRuntimeConfig;
}

function parseString(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : fallback;
}

function parseScrollback(value: unknown, fallback = 5_000): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(200, Math.min(100_000, Math.floor(parsed)));
}

function parseCoreTerminalRuntimeConfig(ctx: ModuleContext): {
  sshConfigPath: string;
  defaultHost: string;
  shellOverride: string;
  scrollback: number;
} {
  const config = readCoreConfig(ctx);
  return {
    sshConfigPath: parseString(config.terminal_ssh_config_path, "~/.ssh/config"),
    defaultHost: parseString(config.terminal_default_host, "Localhost"),
    shellOverride: String(config.terminal_shell_override ?? ""),
    scrollback: parseScrollback(config.terminal_scrollback)
  };
}

function terminalDebug(message: string, details?: unknown): void {
  if (details === undefined) {
    console.debug(`[terminal-debug] ${message}`);
    return;
  }
  console.debug(`[terminal-debug] ${message}`, details);
}

function TerminalConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<TerminalService>(TERMINAL_SERVICE_ID);
  const [state, setState] = useState<TerminalState>(service.getState());
  const [hostSelection, setHostSelection] = useState(state.selectedHost);
  const hostSelectionRef = useRef(hostSelection);
  const activeSessionRef = useRef<string | null>(state.activeSessionId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermLike | null>(null);
  const fitAddonRef = useRef<FitAddonLike | null>(null);

  useEffect(() => {
    hostSelectionRef.current = hostSelection;
  }, [hostSelection]);

  useEffect(() => {
    activeSessionRef.current = state.activeSessionId;
  }, [state.activeSessionId]);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  useEffect(() => {
    if (!state.hosts.includes(hostSelectionRef.current)) {
      const nextSelection = state.selectedHost || state.hosts[0] || "Localhost";
      setHostSelection(nextSelection);
      hostSelectionRef.current = nextSelection;
    }
  }, [state.hosts, state.selectedHost]);

  useEffect(() => {
    if (!state.supported) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let terminalDataUnsubscribe: { dispose: () => void } | null = null;
    let outputUnsubscribe: (() => void) | null = null;
    let syncSizeTimer: ReturnType<typeof setTimeout> | null = null;
    let focusOnPointerDown: ((event: PointerEvent) => void) | null = null;
    let focusContainer: HTMLElement | null = null;

    const setupTerminal = async (): Promise<void> => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("xterm"), import("@xterm/addon-fit")]);
      if (cancelled) return;
      terminalDebug("xterm setup start");
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        scrollback: service.getScrollback(),
        fontFamily: "Consolas, Menlo, Monaco, 'Courier New', monospace",
        theme: {
          background: "#ffffff",
          foreground: "#1f2328",
          cursor: "#0969da",
          selectionBackground: "#ddf4ff",
          black: "#24292f",
          red: "#cf222e",
          green: "#116329",
          yellow: "#4d2d00",
          blue: "#0969da",
          magenta: "#8250df",
          cyan: "#1b7c83",
          white: "#6e7781",
          brightBlack: "#57606a",
          brightRed: "#a40e26",
          brightGreen: "#1a7f37",
          brightYellow: "#633c01",
          brightBlue: "#218bff",
          brightMagenta: "#a475f9",
          brightCyan: "#3192aa",
          brightWhite: "#8c959f"
        }
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminalRef.current = terminal as unknown as XTermLike;
      fitAddonRef.current = fitAddon as unknown as FitAddonLike;
      const container = containerRef.current;
      if (!container) return;
      terminal.open(container);
      fitAddon.fit();
      terminal.focus();
      terminalDebug("xterm setup done", { cols: terminal.cols, rows: terminal.rows });

      const syncTerminalSize = (): void => {
        const activeId = activeSessionRef.current;
        if (!activeId) return;
        fitAddon.fit();
        const proposed = fitAddon.proposeDimensions();
        if (proposed) {
          void service.resizeSession(activeId, proposed.cols, proposed.rows);
          return;
        }
        void service.resizeSession(activeId, terminal.cols, terminal.rows);
      };

      syncSizeTimer = setTimeout(syncTerminalSize, 40);
      terminalDataUnsubscribe = terminal.onData((data) => {
        terminalDebug("xterm onData", { bytes: data.length });
        void service.writeToActive(data);
      });
      outputUnsubscribe = service.subscribeOutput((event) => {
        if (event.sessionId !== activeSessionRef.current) return;
        terminalDebug("xterm write output", { sessionId: event.sessionId, bytes: event.data.length });
        terminal.write(event.data);
      });
      focusOnPointerDown = () => {
        terminalDebug("xterm focus on pointerdown");
        terminal.focus();
      };
      focusContainer = container;
      focusContainer.addEventListener("pointerdown", focusOnPointerDown);
      resizeObserver = new ResizeObserver(() => {
        syncTerminalSize();
      });
      resizeObserver.observe(container);
    };

    void setupTerminal();

    return () => {
      cancelled = true;
      if (syncSizeTimer) {
        clearTimeout(syncSizeTimer);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (terminalDataUnsubscribe) {
        terminalDataUnsubscribe.dispose();
      }
      if (outputUnsubscribe) {
        outputUnsubscribe();
      }
      if (focusOnPointerDown && focusContainer) {
        focusContainer.removeEventListener("pointerdown", focusOnPointerDown);
      }
      fitAddonRef.current = null;
      if (terminalRef.current) {
        terminalRef.current.dispose();
      }
      terminalRef.current = null;
    };
  }, [service, state.supported]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminalDebug("active session render", { activeSessionId: state.activeSessionId });
    terminal.focus();
    terminal.clear();

    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) {
      terminal.writeln("No hay terminal activa. Selecciona un host y presiona +.");
      return;
    }

    const buffer = service.getSessionBuffer(activeSessionId);
    if (buffer.trim().length > 0) {
      terminal.write(buffer);
    } else {
      terminal.writeln(`Sesión iniciada: ${state.sessions.find((entry) => entry.id === activeSessionId)?.host ?? "terminal"}`);
    }

    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    fitAddon.fit();
    const proposed = fitAddon.proposeDimensions();
    if (proposed) {
      void service.resizeSession(activeSessionId, proposed.cols, proposed.rows);
      return;
    }
    void service.resizeSession(activeSessionId, terminal.cols, terminal.rows);
  }, [service, state.activeSessionId, state.sessions]);

  const activeSessionHost = useMemo(() => {
    if (!state.activeSessionId) return "";
    return state.sessions.find((entry) => entry.id === state.activeSessionId)?.host ?? "";
  }, [state.activeSessionId, state.sessions]);

  if (!state.supported) {
    return (
      <div className="terminal-tab-root">
        <div className="terminal-fallback">Terminal disponible solo en desktop (Tauri).</div>
      </div>
    );
  }

  return (
    <div className="terminal-tab-root">
      <div className="terminal-main-panel">
        <div ref={containerRef} className="terminal-xterm-host" />
      </div>

      <div className="terminal-session-strip">
        <div className="terminal-session-tabs">
          {state.sessions.map((session) => (
            <div key={session.id} className={`terminal-session-tab ${session.id === state.activeSessionId ? "active" : ""}`}>
              <button
                type="button"
                className="terminal-session-tab-select"
                onClick={() => service.setActiveSession(session.id)}
                title={`Terminal ${session.label}`}
              >
                {session.label}
              </button>
              <button
                type="button"
                className="terminal-session-tab-close"
                onClick={() => void service.closeSession(session.id)}
                title={`Cerrar ${session.label}`}
                aria-label={`Cerrar ${session.label}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-session-actions">
          <select
            className="terminal-host-select"
            value={hostSelection}
            onChange={(event) => {
              setHostSelection(event.target.value);
              service.setSelectedHost(event.target.value);
            }}
            title="Host de terminal"
          >
            {state.hosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void service.openSession(hostSelection)}
            disabled={state.creatingSession || state.loadingHosts}
            title="Nueva terminal"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => void service.refreshHosts()}
            disabled={state.loadingHosts}
            title="Recargar hosts SSH"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="terminal-strip-status">
        {state.lastError ? <span className="terminal-error">{state.lastError}</span> : null}
        {!state.lastError && activeSessionHost ? <span className="terminal-muted">Activo: {activeSessionHost}</span> : null}
      </div>
    </div>
  );
}

export function createTerminalModule(): CockpitModule {
  return {
    id: "terminal",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const runtimeConfig = parseCoreTerminalRuntimeConfig(ctx);
      const terminalService = new TerminalService({
        sshConfigPath: runtimeConfig.sshConfigPath,
        defaultHost: runtimeConfig.defaultHost,
        shellOverride: runtimeConfig.shellOverride,
        scrollback: runtimeConfig.scrollback
      });

      ctx.services.registerService({
        id: TERMINAL_SERVICE_ID,
        service: terminalService
      });

      ctx.contributions.register({
        id: "console.terminal",
        slot: "console",
        label: "Terminal",
        render: () => <TerminalConsoleTab runtime={ctx} />
      });

      ctx.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
        const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
        if (packageId !== "core") return;
        const next = parseCoreTerminalRuntimeConfig(ctx);
        terminalService.applyRuntimeConfig({
          sshConfigPath: next.sshConfigPath,
          defaultHost: next.defaultHost,
          shellOverride: next.shellOverride
        });
      });
    }
  };
}

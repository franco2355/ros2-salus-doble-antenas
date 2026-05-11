import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ModuleContext } from "../../../../../core/types/module";

const PTY_WS_URL = "ws://127.0.0.1:7681";
const TERMINAL_TARGETS = ["local", "salus"] as const;
type TerminalTarget = (typeof TERMINAL_TARGETS)[number];

const DEFAULT_CWD_BY_TARGET: Record<TerminalTarget, string> = {
  local: "/home/franco",
  salus: "~/ros2_ws"
};

const TARGET_LABELS: Record<TerminalTarget, string> = {
  local: "local",
  salus: "salus"
};

interface Session {
  id: string;
  label: string;
  target: TerminalTarget;
  cwd: string;
  term: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket | null;
  connected: boolean;
  notifyStatus: () => void;
  inputDisposable?: IDisposable;
  resizeDisposable?: IDisposable;
  oscDisposable?: IDisposable;
}

let sessionCounter = 0;

function defaultCwd(target: TerminalTarget): string {
  return DEFAULT_CWD_BY_TARGET[target];
}

function createSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `terminal-${globalThis.crypto.randomUUID()}`;
  }
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function findLastSessionIndex(sessions: Session[], id: string): number {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (sessions[index]?.id === id) return index;
  }
  return -1;
}

function parseOsc7Cwd(data: string): string | null {
  const raw = String(data || "").trim();
  if (!raw) return null;

  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      return decodeURIComponent(url.pathname || "/");
    } catch {
      const pathStart = raw.indexOf("/", "file://".length);
      if (pathStart >= 0) return raw.slice(pathStart);
    }
  }

  return raw.startsWith("/") || raw.startsWith("~") ? raw : null;
}

function buildPtyUrl(session: Session): string {
  const url = new URL(PTY_WS_URL);
  url.searchParams.set("target", session.target);
  url.searchParams.set("cwd", session.cwd || defaultCwd(session.target));
  return url.toString();
}

function safeDispose(disposable?: IDisposable): void {
  try {
    disposable?.dispose();
  } catch {
    // xterm disposables should be best-effort during terminal reconnects.
  }
}

function makeSession(target: TerminalTarget = "local"): Session {
  sessionCounter += 1;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Roboto Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    fontSize: 12,
    lineHeight: 1.22,
    scrollback: 8000,
    theme: {
      background: "#ffffff",
      foreground: "#111827",
      cursor: "#111827",
      selectionBackground: "rgba(37,99,235,0.22)",
      black: "#1e2127", red: "#d73a49", green: "#22863a", yellow: "#b08800",
      blue: "#0366d6", magenta: "#6f42c1", cyan: "#0598bc", white: "#d1d5db",
      brightBlack: "#6b7280", brightRed: "#cb2431", brightGreen: "#28a745",
      brightYellow: "#dbab09", brightBlue: "#2188ff", brightMagenta: "#8a63d2",
      brightCyan: "#12a8c8", brightWhite: "#ffffff",
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const session: Session = {
    id: createSessionId(),
    label: `T${sessionCounter}`,
    target,
    cwd: defaultCwd(target),
    term,
    fitAddon,
    ws: null,
    connected: false,
    notifyStatus: () => undefined
  };

  session.oscDisposable = term.parser.registerOscHandler(7, (data) => {
    const nextCwd = parseOsc7Cwd(data);
    if (!nextCwd || nextCwd === session.cwd) return true;
    session.cwd = nextCwd;
    session.notifyStatus();
    return true;
  });

  return session;
}

function closeSocket(session: Session): void {
  const socket = session.ws;
  session.ws = null;
  session.connected = false;
  safeDispose(session.inputDisposable);
  safeDispose(session.resizeDisposable);
  session.inputDisposable = undefined;
  session.resizeDisposable = undefined;

  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.close();
  }
}

function disposeSession(session: Session): void {
  closeSocket(session);
  safeDispose(session.oscDisposable);
  try {
    session.term.dispose();
  } catch {
    // Terminal disposal can throw after xterm has already detached from the DOM.
  }
}

function connectWs(session: Session, onStatus: () => void): void {
  if (session.ws && session.ws.readyState <= WebSocket.OPEN) return;
  session.notifyStatus = onStatus;

  const ws = new WebSocket(buildPtyUrl(session));
  ws.binaryType = "arraybuffer";
  session.ws = ws;

  ws.onopen = () => {
    if (session.ws !== ws) return;
    session.connected = true;
    onStatus();
    ws.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
  };
  ws.onmessage = (ev) => {
    if (session.ws !== ws) return;
    const data = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : (ev.data as string);
    session.term.write(data);
  };
  ws.onclose = () => {
    if (session.ws !== ws) return;
    session.ws = null;
    session.connected = false;
    onStatus();
    session.term.writeln("\r\n\x1b[33m[Desconectado del servidor PTY]\x1b[0m");
  };
  ws.onerror = () => {
    if (session.ws !== ws) return;
    session.connected = false;
    onStatus();
    session.term.writeln("\r\n\x1b[31m[Error: no se pudo conectar a ws://127.0.0.1:7681. Corré ./start.sh]\x1b[0m");
  };

  safeDispose(session.inputDisposable);
  safeDispose(session.resizeDisposable);
  session.inputDisposable = session.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  session.resizeDisposable = session.term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
}

function TerminalStatusIcon(): JSX.Element {
  return (
    <svg className="pty-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 10 3 3-3 3" />
      <path d="M13 16h4" />
    </svg>
  );
}

function MonitorStatusIcon(): JSX.Element {
  return (
    <svg className="pty-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="12" rx="1.8" />
      <path d="M12 16v4" />
      <path d="M8 20h8" />
    </svg>
  );
}

function FolderStatusIcon(): JSX.Element {
  return (
    <svg className="pty-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6.5a2 2 0 0 1 2-2H9l2 2H18.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function TerminalConsoleTab({ runtime: _runtime }: { runtime: ModuleContext }): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [, tick] = useState(0);
  const rerender = () => tick((n) => n + 1);

  const sessionsRef = useRef<Session[]>(sessions);
  const activeIdRef = useRef(activeId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const divRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const opened = useRef<Set<string>>(new Set());
  const initialCreated = useRef(false);

  // Crea la primera sesión después del mount — el guard evita la doble
  // ejecución de StrictMode, que de lo contrario generaría T2, T4, T6...
  useEffect(() => {
    if (initialCreated.current) return;
    initialCreated.current = true;
    const s = makeSession("local");
    setSessions([s]);
    setActiveId(s.id);
  }, []);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const seen = new Set<string>();
    let changed = false;
    let nextActiveId = activeId;

    sessions.forEach((session) => {
      if (session.id && !seen.has(session.id)) {
        seen.add(session.id);
        return;
      }

      const previousId = session.id;
      session.id = createSessionId();
      seen.add(session.id);
      changed = true;
      if (previousId === activeId) nextActiveId = session.id;
    });

    if (!changed) return;
    setSessions([...sessions]);
    if (nextActiveId !== activeId) setActiveId(nextActiveId);
  }, [activeId, sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const fitAndFocusActiveSession = () => {
    const activeSession = sessionsRef.current.find((s) => s.id === activeIdRef.current);
    if (!activeSession || !opened.current.has(activeSession.id)) return;
    requestAnimationFrame(() => {
      try {
        activeSession.fitAddon.fit();
        activeSession.term.focus();
      } catch {
        // xterm may still be hidden during a console tab transition.
      }
    });
  };

  useEffect(() => {
    sessions.forEach((s) => {
      if (opened.current.has(s.id)) return;
      const el = divRefs.current[s.id];
      if (!el) return;

      opened.current.add(s.id);
      s.notifyStatus = rerender;
      s.term.open(el);

      // RAF garantiza que el browser ya calculó el layout antes de fit()
      requestAnimationFrame(() => {
        try { s.fitAddon.fit(); } catch { /* ignore */ }
        s.term.focus();
        connectWs(s, rerender);
      });
    });
  }, [sessions]);

  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId);
    if (!s || !opened.current.has(s.id)) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          s.fitAddon.fit();
          s.term.scrollToBottom();
          s.term.focus();
        } catch {
          // Fit can fail while the terminal slot is hidden.
        }
      });
    });
  }, [activeId, sessions]);

  useEffect(() => {
    const onConsoleTabActive = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== "console.terminal") return;
      fitAndFocusActiveSession();
    };
    window.addEventListener("cockpit:console-tab-active", onConsoleTabActive);
    return () => window.removeEventListener("cockpit:console-tab-active", onConsoleTabActive);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => {
      sessions.forEach((s) => {
        if (!opened.current.has(s.id)) return;
        try {
          s.fitAddon.fit();
        } catch {
          // Fit can fail while xterm is between layout passes.
        }
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessions]);

  useEffect(() => {
    return () => {
      sessionsRef.current.forEach(disposeSession);
    };
  }, []);

  const resolvedActiveIndex = activeId ? findLastSessionIndex(sessions, activeId) : -1;
  const activeIndex = resolvedActiveIndex >= 0 ? resolvedActiveIndex : 0;
  const active = sessions[activeIndex] ?? null;
  const nextTarget = active?.target === "local" ? "salus" : "local";
  const terminalCountLabel = `${sessions.length} ${sessions.length === 1 ? "terminal" : "terminals"}`;

  const addSession = () => {
    const s = makeSession(active?.target ?? "local");
    s.notifyStatus = rerender;
    setSessions((cur) => [...cur, s]);
    setActiveId(s.id);
  };

  const restartSession = (session: Session) => {
    closeSocket(session);
    session.term.clear();
    session.term.writeln(`\x1b[36m[Conectando a ${TARGET_LABELS[session.target]}]\x1b[0m`);
    rerender();
    window.setTimeout(() => connectWs(session, rerender), 0);
  };

  const setActiveTarget = (target: TerminalTarget) => {
    if (!active || active.target === target) return;
    active.target = target;
    active.cwd = defaultCwd(target);
    restartSession(active);
  };

  const closeSession = (id: string) => {
    const sessionIndex = findLastSessionIndex(sessions, id);
    const s = sessionIndex >= 0 ? sessions[sessionIndex] : null;
    if (!s || sessions.length <= 1) return;
    disposeSession(s);
    opened.current.delete(id);
    delete divRefs.current[id];
    const rest = sessions.filter((_, index) => index !== sessionIndex);
    setSessions(rest);
    if (activeId === id) setActiveId(rest[0]!.id);
  };

  return (
    <div className="pty-shell-wrap" onMouseDown={fitAndFocusActiveSession}>
      <div className="pty-tabbar">
        <div className="pty-tabs">
          {sessions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`pty-tab ${i === activeIndex ? "pty-tab--active" : ""}`}
              onClick={() => setActiveId(s.id)}
              title={`T${i + 1} · ${TARGET_LABELS[s.target]} · ${s.cwd}`}
            >
              <span className={`pty-dot ${s.connected ? "pty-dot--on" : "pty-dot--off"}`} />
              <span className="pty-tab-label">T{i + 1}</span>
            </button>
          ))}
        </div>
        <div className="pty-actions">
          {active && !active.connected && (
            <button type="button" className="pty-btn pty-btn--reconnect" onClick={() => restartSession(active)}>
              Reconectar
            </button>
          )}
          <button type="button" className="pty-btn" onClick={addSession} title="Nueva terminal">+</button>
          <button
            type="button"
            className="pty-btn pty-btn--close"
            onClick={() => closeSession(activeId)}
            disabled={sessions.length <= 1}
            title="Cerrar terminal"
          >
            ×
          </button>
        </div>
      </div>

      <div className="pty-viewport" ref={viewportRef}>
        {sessions.map((s, i) => (
          <div
            key={s.id}
            className="pty-term-slot"
            style={{ display: i === activeIndex ? "block" : "none" }}
            ref={(el) => { divRefs.current[s.id] = el; }}
          />
        ))}
      </div>

      <div className="pty-statusbar" aria-label="Terminal context">
        <span className="pty-status-item pty-status-item--terminals">
          <TerminalStatusIcon />
          <span>{terminalCountLabel}</span>
        </span>
        <span className="pty-status-separator" aria-hidden="true" />
        <button
          type="button"
          className="pty-status-item pty-status-button pty-status-item--target"
          onClick={() => setActiveTarget(nextTarget)}
          title={`Cambiar destino a ${TARGET_LABELS[nextTarget]}`}
          aria-label={`Destino actual ${active ? TARGET_LABELS[active.target] : ""}. Cambiar a ${TARGET_LABELS[nextTarget]}`}
        >
          <MonitorStatusIcon />
          <span>{active ? TARGET_LABELS[active.target] : ""}</span>
        </button>
        <span className="pty-status-separator" aria-hidden="true" />
        <span className="pty-status-item pty-status-item--path" title={active?.cwd ?? ""}>
          <FolderStatusIcon />
          <span className="pty-status-path-text">{active?.cwd ?? ""}</span>
        </span>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ConsoleHost } from "./layout/ConsoleHost";
import { FooterHost } from "./layout/FooterHost";
import { GlobalDialogHost } from "./layout/GlobalDialogHost";
import { ModalHost } from "./layout/ModalHost";
import { SidebarHost } from "./layout/SidebarHost";
import { TopToolbar } from "./layout/TopToolbar";
import { WorkspaceHost } from "./layout/WorkspaceHost";
import type { AppRuntime } from "../core/types/module";
import { NAV_EVENTS } from "../core/events/topics";
import { DIALOG_SERVICE_ID, type DialogService } from "../services/impl/DialogService";

interface AppShellProps {
  runtime: AppRuntime;
}

interface ConnectionServiceLike {
  getState(): { connected: boolean; lastError: string };
  subscribe(listener: (state: { connected: boolean; lastError: string }) => void): () => void;
}

interface NavigationServiceLike {
  getState(): { goalMode: boolean; manualMode: boolean };
  toggleGoalMode(): boolean;
  requestSnapshot(): Promise<unknown>;
  setManualMode(enabled: boolean): Promise<unknown>;
  toggleCameraZoom(): Promise<unknown>;
  setManualKeyState(key: "w" | "a" | "s" | "d", pressed: boolean): void;
  setManualBrakeHeld(pressed: boolean): void;
  panCamera(angleDeg: number): Promise<unknown>;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function sidebarEmoji(panelId: string): string {
  if (panelId.includes("connection")) return "🔌";
  if (panelId.includes("navigation")) return "🧭";
  if (panelId.includes("manual")) return "🎮";
  if (panelId.includes("camera")) return "📷";
  if (panelId.includes("telemetry")) return "📡";
  if (panelId.includes("zone")) return "🗺️";
  if (panelId.includes("map")) return "🗺️";
  return "🧩";
}

function sidebarTooltipLabel(label: string): string {
  const normalized = label.trim();
  const labels: Record<string, string> = {
    Connection: "Conexión",
    Navigation: "Navegación",
    Telemetry: "Telemetría",
    Debug: "Depuración",
    Settings: "Configuración",
    Map: "Mapa",
    Zones: "Zonas",
    "Zone List": "Lista de zonas",
    "Speed limits": "Límites de velocidad",
    "Camera PTZ": "Cámara PTZ"
  };
  return labels[normalized] ?? normalized;
}

function isDisconnectedErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    normalized.includes(" is disconnected") ||
    normalized.includes("disconnected (") ||
    normalized.includes("connection lost") ||
    normalized.includes("websocket connection failed") ||
    normalized.includes("no active connection")
  );
}

const CONNECTION_SERVICE_ID = "service.connection";

export function AppShell({ runtime }: AppShellProps): JSX.Element {
  const toolbarMenus = runtime.registries.toolbarMenuRegistry.list();
  const sidebarPanels = runtime.registries.sidebarPanelRegistry.list();
  const workspaceViews = runtime.registries.workspaceViewRegistry.list();
  const consoleTabs = runtime.registries.consoleTabRegistry.list();
  const modalDialogs = runtime.registries.modalRegistry.list();
  const footerItems = runtime.registries.footerItemRegistry.list();

  const [activeSidebarId, setActiveSidebarId] = useState<string>(sidebarPanels[0]?.id ?? "");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(workspaceViews[0]?.id ?? "");
  const [activeConsoleId, setActiveConsoleId] = useState<string>(consoleTabs[0]?.id ?? "");
  const [activeModalId, setActiveModalId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [consoleHeight, setConsoleHeight] = useState(220);

  useEffect(() => {
    if (activeSidebarId && sidebarPanels.some((panel) => panel.id === activeSidebarId)) return;
    setActiveSidebarId(sidebarPanels[0]?.id ?? "");
  }, [activeSidebarId, sidebarPanels]);

  useEffect(() => {
    if (activeWorkspaceId && workspaceViews.some((view) => view.id === activeWorkspaceId)) return;
    setActiveWorkspaceId(workspaceViews[0]?.id ?? "");
  }, [activeWorkspaceId, workspaceViews]);

  useEffect(() => {
    if (activeConsoleId && consoleTabs.some((tab) => tab.id === activeConsoleId)) return;
    setActiveConsoleId(consoleTabs[0]?.id ?? "");
  }, [activeConsoleId, consoleTabs]);

  useEffect(() => {
    let connectionService: ConnectionServiceLike | null = null;
    let dialogService: DialogService | null = null;
    try {
      connectionService = runtime.getService<ConnectionServiceLike>(CONNECTION_SERVICE_ID);
      dialogService = runtime.getService<DialogService>(DIALOG_SERVICE_ID);
    } catch {
      connectionService = null;
      dialogService = null;
    }
    if (!connectionService || !dialogService) return;

    let connected = connectionService.getState().connected;
    let notifiedLoss = false;
    let lastNoConnectionNoticeAt = 0;

    const notifyLostConnection = (reason: string): void => {
      if (notifiedLoss) return;
      notifiedLoss = true;
      const detail = reason.trim() ? `\n\nDetalle: ${reason.trim()}` : "";
      void dialogService.alert({
        title: "Conexión perdida",
        message: `Se perdió la conexión con el backend remoto.${detail}`,
        confirmLabel: "Entendido",
        danger: true
      });
    };

    const notifyNoConnection = (): void => {
      const now = Date.now();
      if (now - lastNoConnectionNoticeAt < 1200) return;
      lastNoConnectionNoticeAt = now;
      void dialogService.alert({
        title: "Sin conexión activa",
        message: "No hay conexión activa con el backend. Conéctate para ejecutar esta acción.",
        confirmLabel: "Entendido",
        danger: true
      });
    };

    const unsubscribeConnection = connectionService.subscribe((next) => {
      const lostByTransition = connected && !next.connected && next.lastError.trim().length > 0;
      connected = next.connected;
      if (next.connected) {
        notifiedLoss = false;
      } else if (lostByTransition) {
        notifyLostConnection(next.lastError);
      }
    });

    const unsubscribeConsole = runtime.eventBus.on<{ level?: unknown; text?: unknown }>("console.event", (entry) => {
      const level = typeof entry.level === "string" ? entry.level : "";
      if (level !== "error") return;
      const rawText = typeof entry.text === "string" ? entry.text : "";
      if (!isDisconnectedErrorText(rawText)) return;
      if (connected) {
        notifyLostConnection(rawText);
        return;
      }
      notifyNoConnection();
    });

    return () => {
      unsubscribeConnection();
      unsubscribeConsole();
    };
  }, [runtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      const withCtrl = event.ctrlKey && !event.altKey && !event.metaKey;
      if (withCtrl && event.code === "KeyJ") {
        setConsoleCollapsed((prev) => !prev);
        event.preventDefault();
        return;
      }
      if (withCtrl && event.code === "KeyB") {
        setSidebarCollapsed((prev) => !prev);
        event.preventDefault();
        return;
      }

      let dialogService: DialogService | null = null;
      try {
        dialogService = runtime.getService<DialogService>(DIALOG_SERVICE_ID);
      } catch {
        dialogService = null;
      }
      if (dialogService?.getActiveDialog()) {
        if (event.key === "Escape") {
          dialogService.dismiss();
          event.preventDefault();
        }
        return;
      }

      let navigationService: NavigationServiceLike | null = null;
      try {
        navigationService = runtime.getService<NavigationServiceLike>("service.navigation");
      } catch {
        navigationService = null;
      }

      if (event.key === "Escape") {
        if (activeModalId) {
          if (event.shiftKey && activeModalId === "modal.snapshot") {
            runtime.eventBus.emit(NAV_EVENTS.snapshotDownloadRequest, {});
          }
          setActiveModalId(null);
          event.preventDefault();
          return;
        }
        if (navigationService?.getState().goalMode) {
          navigationService.toggleGoalMode();
          runtime.eventBus.emit("console.event", {
            level: "info",
            text: "Goal mode disabled (Esc)",
            timestamp: Date.now()
          });
          event.preventDefault();
          return;
        }
      }

      if (event.code === "KeyQ") {
        setActiveModalId("modal.snapshot");
        if (navigationService) {
          void navigationService
            .requestSnapshot()
            .then(() => {
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: "Snapshot captured (hotkey)",
                timestamp: Date.now()
              });
            })
            .catch((error) => {
              runtime.eventBus.emit("console.event", {
                level: "error",
                text: `Snapshot capture failed: ${String(error)}`,
                timestamp: Date.now()
              });
            });
        } else {
          runtime.eventBus.emit(NAV_EVENTS.snapshotCaptureRequest, {});
        }
        event.preventDefault();
        return;
      }

      if (activeModalId) return;

      if (event.code === "KeyI" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        setActiveModalId("modal.info");
        event.preventDefault();
        return;
      }

      if (event.code === "KeyE") {
        runtime.eventBus.emit(NAV_EVENTS.swapWorkspaceRequest, {});
        event.preventDefault();
        return;
      }

      if (event.code === "KeyF" && navigationService) {
        const enabled = navigationService.toggleGoalMode();
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: enabled ? "Goal mode enabled (hotkey)" : "Goal mode disabled (hotkey)",
          timestamp: Date.now()
        });
        event.preventDefault();
        return;
      }

      if (event.code === "KeyM" && navigationService) {
        const current = navigationService.getState().manualMode;
        void navigationService
          .setManualMode(!current)
          .then(() => {
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: !current ? "Manual mode enabled (hotkey)" : "Manual mode disabled (hotkey)",
              timestamp: Date.now()
            });
          })
          .catch((error) => {
            runtime.eventBus.emit("console.event", {
              level: "error",
              text: `Manual mode hotkey failed: ${String(error)}`,
              timestamp: Date.now()
            });
          });
        event.preventDefault();
      }

      if ((event.code === "Minus" || event.code === "NumpadSubtract") && navigationService) {
        void navigationService.toggleCameraZoom();
        event.preventDefault();
        return;
      }

      if (navigationService) {
        const manualKeyByCode: Record<string, "w" | "a" | "s" | "d"> = {
          KeyW: "w",
          KeyA: "a",
          KeyS: "s",
          KeyD: "d"
        };
        const manualKey = manualKeyByCode[event.code];
        if (manualKey) {
          navigationService.setManualKeyState(manualKey, true);
          event.preventDefault();
          return;
        }
        if (event.code === "Space") {
          navigationService.setManualBrakeHeld(true);
          event.preventDefault();
          return;
        }
      }

      if (navigationService) {
        const cameraArrowByCode: Record<string, number> = {
          ArrowUp: 0,
          ArrowDown: 180,
          ArrowLeft: 90,
          ArrowRight: -90
        };
        const angle = cameraArrowByCode[event.code];
        if (typeof angle === "number") {
          void navigationService.panCamera(angle);
          event.preventDefault();
          return;
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;
      let navigationService: NavigationServiceLike | null = null;
      try {
        navigationService = runtime.getService<NavigationServiceLike>("service.navigation");
      } catch {
        navigationService = null;
      }
      if (!navigationService) return;

      const manualKeyByCode: Record<string, "w" | "a" | "s" | "d"> = {
        KeyW: "w",
        KeyA: "a",
        KeyS: "s",
        KeyD: "d"
      };
      const manualKey = manualKeyByCode[event.code];
      if (manualKey) {
        navigationService.setManualKeyState(manualKey, false);
        event.preventDefault();
        return;
      }
      if (event.code === "Space") {
        navigationService.setManualBrakeHeld(false);
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [activeModalId, runtime]);

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const initial = sidebarWidth;
    const onMove = (moveEvent: MouseEvent): void => {
      const next = Math.max(260, Math.min(560, initial + (moveEvent.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startConsoleResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (consoleCollapsed) return;
    event.preventDefault();
    const startY = event.clientY;
    const initial = consoleHeight;
    const onMove = (moveEvent: MouseEvent): void => {
      const next = Math.max(120, Math.min(420, initial - (moveEvent.clientY - startY)));
      setConsoleHeight(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const activeSidebarPanel = sidebarPanels.find((panel) => panel.id === activeSidebarId) ?? null;
  const activeWorkspace = workspaceViews.find((view) => view.id === activeWorkspaceId) ?? null;
  const shellBodyColumns = sidebarCollapsed
    ? "52px minmax(0, 1fr)"
    : `52px ${sidebarWidth}px 4px minmax(0, 1fr)`;

  return (
    <div className="shell">
      <TopToolbar runtime={runtime} menus={toolbarMenus} openModal={setActiveModalId} />
      <div
        className="shell-body"
        style={{
          gridTemplateColumns: shellBodyColumns
        }}
      >
        <div className="sidebar-selector">
          {sidebarPanels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={panel.id === activeSidebarId ? "active" : ""}
              onClick={() => {
                setActiveSidebarId(panel.id);
                setSidebarCollapsed(false);
              }}
              title={sidebarTooltipLabel(panel.label)}
              aria-label={sidebarTooltipLabel(panel.label)}
            >
              <span aria-hidden="true">{sidebarEmoji(panel.id)}</span>
            </button>
          ))}
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            title={sidebarCollapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
            aria-label={sidebarCollapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
        </div>
        {!sidebarCollapsed ? <SidebarHost runtime={runtime} panel={activeSidebarPanel} /> : null}
        {!sidebarCollapsed ? (
          <div
            className="splitter-vertical"
            onMouseDown={startSidebarResize}
            role="separator"
            aria-orientation="vertical"
          />
        ) : null}
        <main className="workspace-column">
          <section className="workspace-selector">
            {workspaceViews.map((view) => (
              <button
                key={view.id}
                type="button"
                className={view.id === activeWorkspaceId ? "active" : ""}
                onClick={() => setActiveWorkspaceId(view.id)}
              >
                {view.label}
              </button>
            ))}
          </section>
          <WorkspaceHost runtime={runtime} view={activeWorkspace} />
          <div
            className={`splitter-horizontal ${consoleCollapsed ? "collapsed" : ""}`}
            onMouseDown={startConsoleResize}
            role="separator"
            aria-orientation="horizontal"
          />
          <ConsoleHost
            runtime={runtime}
            tabs={consoleTabs}
            activeTabId={activeConsoleId}
            onSelectTab={setActiveConsoleId}
            collapsed={consoleCollapsed}
            height={consoleCollapsed ? 36 : consoleHeight}
          />
        </main>
      </div>
      <ModalHost runtime={runtime} dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
      <GlobalDialogHost runtime={runtime} />
      <FooterHost
        runtime={runtime}
        items={footerItems}
        consoleCollapsed={consoleCollapsed}
        onToggleConsoleCollapse={() => setConsoleCollapsed((prev) => !prev)}
      />
    </div>
  );
}

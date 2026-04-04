import { useEffect, useState } from "react";
import { ToolbarMenu, Panel, WorkspacePanel, ConsolePanel, Footer } from "../packages/core";
import { GlobalDialogHost } from "./layout/GlobalDialogHost";
import { ModalHost } from "./layout/ModalHost";
import type { AppRuntime } from "../core/types/module";
import { NAV_EVENTS } from "../core/events/topics";
import { DIALOG_SERVICE_ID, type DialogService } from "../packages/core/modules/runtime/service/impl/DialogService";
import { SYSTEM_NOTIFICATION_SERVICE_ID, type SystemNotificationService } from "../packages/core/modules/runtime/service/impl/SystemNotificationService";

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

function isCameraDisabledPresetError(text: string): boolean {
  return text.toLowerCase().includes("camera disabled in current preset");
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

  const resolveModalId = (modalId: string): string => {
    if (modalDialogs.some((dialog) => dialog.id === modalId)) return modalId;
    const suffix = `.${modalId}`;
    const namespaced = modalDialogs.find((dialog) => dialog.id.endsWith(suffix));
    return namespaced?.id ?? modalId;
  };
  const snapshotModalId = resolveModalId("modal.snapshot");
  const infoModalId = resolveModalId("modal.info");
  const openModal = (modalId: string): void => {
    setActiveModalId(resolveModalId(modalId));
  };

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
    let notificationService: SystemNotificationService | null = null;
    try {
      notificationService = runtime.getService<SystemNotificationService>(SYSTEM_NOTIFICATION_SERVICE_ID);
    } catch {
      notificationService = null;
    }
    if (!notificationService) return;
    const stop = notificationService.start({ runtime });
    return () => {
      stop();
    };
  }, [runtime]);

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
          if (event.shiftKey && activeModalId === snapshotModalId) {
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
        openModal(snapshotModalId);
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
              const message = String(error);
              if (isCameraDisabledPresetError(message)) {
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Snapshot no disponible para el preset de conexión actual.",
                  timestamp: Date.now()
                });
                return;
              }
              runtime.eventBus.emit("console.event", {
                level: "error",
                text: `Snapshot capture failed: ${message}`,
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
        openModal(infoModalId);
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
  }, [activeModalId, runtime, snapshotModalId, infoModalId]);

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

  const shellBodyColumns = sidebarCollapsed
    ? "52px minmax(0, 1fr)"
    : `52px ${sidebarWidth}px 4px minmax(0, 1fr)`;

  return (
    <div className="shell">
      <ToolbarMenu runtime={runtime} menus={toolbarMenus} openModal={openModal} />
      <div
        className="shell-body"
        style={{
          gridTemplateColumns: shellBodyColumns
        }}
      >
        <Panel
          runtime={runtime}
          panels={sidebarPanels}
          activePanelId={activeSidebarId}
          onSelectPanel={(id) => {
            if (id === activeSidebarId) {
              setSidebarCollapsed((prev) => !prev);
              return;
            }
            setActiveSidebarId(id);
            setSidebarCollapsed(false);
          }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          width={sidebarWidth}
          onResizeStart={startSidebarResize}
        />
        <WorkspacePanel
          runtime={runtime}
          views={workspaceViews}
          activeViewId={activeWorkspaceId}
          onSelectView={setActiveWorkspaceId}
        >
          <div
            className={`splitter-horizontal ${consoleCollapsed ? "collapsed" : ""}`}
            onMouseDown={startConsoleResize}
            role="separator"
            aria-orientation="horizontal"
          />
          <ConsolePanel
            runtime={runtime}
            tabs={consoleTabs}
            activeTabId={activeConsoleId}
            onSelectTab={setActiveConsoleId}
            collapsed={consoleCollapsed}
            height={consoleCollapsed ? 36 : consoleHeight}
          />
        </WorkspacePanel>
      </div>
      <ModalHost runtime={runtime} dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
      <GlobalDialogHost runtime={runtime} />
      <Footer
        runtime={runtime}
        items={footerItems}
        consoleCollapsed={consoleCollapsed}
        onToggleConsoleCollapse={() => setConsoleCollapsed((prev) => !prev)}
      />
    </div>
  );
}

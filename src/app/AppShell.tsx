import { useEffect, useMemo, useState } from "react";
import { ToolbarMenu, Panel, WorkspacePanel, ConsolePanel, Footer } from "../packages/core";
import type { KeybindingContext } from "../core/keybindings/types";
import { useSlot } from "../core/contributions/useSlot";
import { GlobalDialogHost } from "./layout/GlobalDialogHost";
import { KeybindingHost } from "./layout/KeybindingHost";
import { ModalHost } from "./layout/ModalHost";
import { ZoomHost } from "./layout/ZoomHost";
import { registerShellCommands } from "./shellCommands";
import type { AppRuntime } from "../core/types/module";
import { DIALOG_SERVICE_ID, type DialogService } from "../packages/core/modules/runtime/service/impl/DialogService";
import { SYSTEM_NOTIFICATION_SERVICE_ID, type SystemNotificationService } from "../packages/core/modules/runtime/service/impl/SystemNotificationService";
import { UiZoomController } from "./zoomController";
import { emitConsoleEvent, emitProjection, emitSidebarSnapshot, isHostBridgeAvailable } from "../platform/host/bridge";

interface AppShellProps {
  runtime: AppRuntime;
  layoutMode?: "default" | "vscode";
}

interface ConnectionServiceLike {
  getState(): { connected: boolean; lastError: string };
  subscribe(listener: (state: { connected: boolean; lastError: string }) => void): () => void;
}

interface SidebarConnectionState {
  connected: boolean;
  connecting?: boolean;
  preset?: string;
  host?: string;
  port?: string;
  lastError?: string;
}

interface NavigationServiceLike {
  getState(): {
    goalMode: boolean;
    manualMode: boolean;
    controlLocked: boolean;
    controlLockReason?: string;
    selectedWaypointIndexes: number[];
    cameraStreamConnected?: boolean;
  };
  subscribe(listener: (state: ReturnType<NavigationServiceLike["getState"]>) => void): () => void;
}

interface SensorInfoServiceLike {
  getState(): {
    payloads?: {
      general?: {
        snapshot?: {
          datum?: { already_set?: boolean };
          rtk_source_state?: { connected?: boolean };
        };
      };
      pixhawk_gps?: {
        snapshot?: {
          diagnostics?: {
            yaw_delta_deg?: number;
          };
        };
      };
    };
  };
  subscribe(listener: (state: ReturnType<SensorInfoServiceLike["getState"]>) => void): () => void;
}

interface TelemetryServiceLike {
  getSnapshot(): {
    recentEvents: Array<unknown>;
    alerts: Array<unknown>;
  };
  subscribeTelemetry(listener: (snapshot: ReturnType<TelemetryServiceLike["getSnapshot"]>) => void): () => void;
}

interface HostCommandMessage {
  type: "cockpit.host.command";
  commandId?: string;
  args?: unknown[];
  activateWorkspaceId?: string;
  activateConsoleId?: string;
  openModalId?: string;
}

function isHostCommandMessage(payload: unknown): payload is HostCommandMessage {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { type?: unknown }).type === "cockpit.host.command";
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const CONNECTION_SERVICE_ID = "service.connection";
const NAVIGATION_SERVICE_ID = "service.navigation";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";
const TELEMETRY_SERVICE_ID = "service.telemetry";

export function AppShell({ runtime, layoutMode = "default" }: AppShellProps): JSX.Element {
  const usingVscodeLayout = layoutMode === "vscode";
  const toolbarMenus = useSlot(runtime.contributions, "toolbar");
  const sidebarPanels = useSlot(runtime.contributions, "sidebar");
  const workspaceViews = useSlot(runtime.contributions, "workspace");
  const consoleTabs = useSlot(runtime.contributions, "console");
  const modalDialogs = useSlot(runtime.contributions, "modal");
  const footerItems = useSlot(runtime.contributions, "footer");

  const [activeSidebarId, setActiveSidebarId] = useState<string>(sidebarPanels[0]?.id ?? "");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(workspaceViews[0]?.id ?? "");
  const [activeConsoleId, setActiveConsoleId] = useState<string>(consoleTabs[0]?.id ?? "");
  const [activeModalId, setActiveModalId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [consoleHeight, setConsoleHeight] = useState(220);
  const [zoomController] = useState(() => new UiZoomController());

  const resolveModalId = (modalId: string): string => {
    if (modalDialogs.some((dialog) => dialog.id === modalId)) return modalId;
    const suffix = `.${modalId}`;
    const namespaced = modalDialogs.find((dialog) => dialog.id.endsWith(suffix));
    return namespaced?.id ?? modalId;
  };

  useEffect(() => {
    const disposables = registerShellCommands(runtime, {
      toggleSidebar: () => {
        if (usingVscodeLayout) return;
        setSidebarCollapsed((prev) => !prev);
      },
      toggleConsole: () => {
        if (usingVscodeLayout) return;
        setConsoleCollapsed((prev) => !prev);
      },
      openModal: (modalId: string) => setActiveModalId(resolveModalId(modalId)),
      closeModal: () => setActiveModalId(null),
      getActiveModalId: () => activeModalId,
      zoomIn: async () => {
        await zoomController.zoomIn();
      },
      zoomOut: async () => {
        await zoomController.zoomOut();
      },
      zoomReset: async () => {
        await zoomController.zoomReset();
      }
    });
    return () => disposables.forEach((d) => d.dispose());
  }, [runtime, activeModalId, modalDialogs, zoomController, usingVscodeLayout]);

  useEffect(() => {
    emitProjection(
      "toolbar",
      toolbarMenus.map((menu) => ({
        id: menu.id,
        label: menu.label,
        commandId: menu.commandId,
        order: menu.order,
        items: menu.items?.map((item) => ({
          id: item.id,
          label: item.label,
          commandId: item.commandId
        }))
      }))
    );
  }, [toolbarMenus]);

  useEffect(() => {
    emitProjection(
      "footer",
      footerItems.map((item) => ({
        id: item.id,
        align: item.align,
        beforeId: item.beforeId,
        order: item.order,
        statusBarPriority: item.statusBarPriority
      }))
    );
  }, [footerItems]);

  useEffect(() => {
    if (!usingVscodeLayout || !isHostBridgeAvailable()) return;

    let connectionService: ConnectionServiceLike | null = null;
    let navigationService: NavigationServiceLike | null = null;
    let sensorInfoService: SensorInfoServiceLike | null = null;
    let telemetryService: TelemetryServiceLike | null = null;

    try {
      connectionService = runtime.getService<ConnectionServiceLike>(CONNECTION_SERVICE_ID);
    } catch {
      connectionService = null;
    }

    try {
      navigationService = runtime.getService<NavigationServiceLike>(NAVIGATION_SERVICE_ID);
    } catch {
      navigationService = null;
    }

    try {
      sensorInfoService = runtime.getService<SensorInfoServiceLike>(SENSOR_INFO_SERVICE_ID);
    } catch {
      sensorInfoService = null;
    }

    try {
      telemetryService = runtime.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
    } catch {
      telemetryService = null;
    }

    const publishConnection = (state: SidebarConnectionState): void => {
      const host = String(state.host ?? "").trim();
      const port = String(state.port ?? "").trim();
      emitSidebarSnapshot("connection", {
        connected: state.connected === true,
        connecting: state.connecting === true,
        preset: typeof state.preset === "string" ? state.preset : "",
        endpoint: host && port ? `${host}:${port}` : "",
        host,
        port,
        lastError: typeof state.lastError === "string" ? state.lastError : ""
      });
    };

    const publishNavigation = (state: ReturnType<NavigationServiceLike["getState"]>): void => {
      emitSidebarSnapshot("navigation", {
        goalMode: state.goalMode === true,
        manualMode: state.manualMode === true,
        controlLocked: state.controlLocked === true,
        controlLockReason: typeof state.controlLockReason === "string" ? state.controlLockReason : "",
        selectedWaypoints: Array.isArray(state.selectedWaypointIndexes) ? state.selectedWaypointIndexes.length : 0,
        cameraConnected: state.cameraStreamConnected === true
      });
    };

    const publishTelemetry = (): void => {
      const sensorState = sensorInfoService?.getState();
      const payloads = asRecord(sensorState?.payloads ?? null);
      const generalSnapshot = asRecord(asRecord(payloads?.general)?.snapshot);
      const pixhawkSnapshot = asRecord(asRecord(payloads?.pixhawk_gps)?.snapshot);
      const datum = asRecord(generalSnapshot?.datum);
      const rtkSource = asRecord(generalSnapshot?.rtk_source_state);
      const diagnostics = asRecord(pixhawkSnapshot?.diagnostics);
      const telemetrySnapshot = telemetryService?.getSnapshot();

      const yawRaw = Number(diagnostics?.yaw_delta_deg);
      emitSidebarSnapshot("telemetry", {
        datumSet: datum?.already_set === true,
        rtkConnected: rtkSource?.connected === true,
        yawDeltaDeg: Number.isFinite(yawRaw) ? yawRaw : null,
        recentEvents: Array.isArray(telemetrySnapshot?.recentEvents) ? telemetrySnapshot.recentEvents.length : 0,
        alerts: Array.isArray(telemetrySnapshot?.alerts) ? telemetrySnapshot.alerts.length : 0
      });
    };

    const unsubscribers: Array<() => void> = [];

    if (connectionService) {
      publishConnection(connectionService.getState() as SidebarConnectionState);
      unsubscribers.push(connectionService.subscribe((state) => publishConnection(state as SidebarConnectionState)));
    } else {
      publishConnection({ connected: false, lastError: "Connection service unavailable" });
    }

    if (navigationService) {
      publishNavigation(navigationService.getState());
      unsubscribers.push(navigationService.subscribe((state) => publishNavigation(state)));
    } else {
      emitSidebarSnapshot("navigation", {
        goalMode: false,
        manualMode: false,
        controlLocked: true,
        controlLockReason: "Navigation service unavailable",
        selectedWaypoints: 0,
        cameraConnected: false
      });
    }

    publishTelemetry();

    if (sensorInfoService) {
      unsubscribers.push(
        sensorInfoService.subscribe(() => {
          publishTelemetry();
        })
      );
    }

    if (telemetryService) {
      unsubscribers.push(
        telemetryService.subscribeTelemetry(() => {
          publishTelemetry();
        })
      );
    }

    const stopConsoleEvents = runtime.eventBus.on<{
      level?: unknown;
      text?: unknown;
      timestamp?: unknown;
      source?: unknown;
    }>("console.event", (event) => {
      const text = String(event?.text ?? "").trim();
      if (!text) return;
      const level = String(event?.level ?? "info").toLowerCase();
      const timestampRaw = Number(event?.timestamp ?? Date.now());
      emitConsoleEvent({
        level,
        text,
        timestamp: Number.isFinite(timestampRaw) ? timestampRaw : Date.now(),
        source: typeof event?.source === "string" ? event.source : undefined
      });
    });

    return () => {
      stopConsoleEvents();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [runtime, usingVscodeLayout]);

  const keybindingContext = useMemo<KeybindingContext>(
    () => ({
      modalOpen: activeModalId !== null,
      editing: false
    }),
    [activeModalId]
  );

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

    const unsubscribeConnection = connectionService.subscribe((next) => {
      const lostByTransition = connected && !next.connected && next.lastError.trim().length > 0;
      connected = next.connected;
      if (next.connected) {
        notifiedLoss = false;
      } else if (lostByTransition) {
        notifyLostConnection(next.lastError);
      }
    });

    return () => {
      unsubscribeConnection();
    };
  }, [runtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [runtime]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isHostCommandMessage(event.data)) return;
      const payload = event.data;

      if (payload.activateWorkspaceId && workspaceViews.some((view) => view.id === payload.activateWorkspaceId)) {
        setActiveWorkspaceId(payload.activateWorkspaceId);
      }

      if (payload.activateConsoleId && consoleTabs.some((tab) => tab.id === payload.activateConsoleId)) {
        setActiveConsoleId(payload.activateConsoleId);
      }

      if (payload.openModalId) {
        setActiveModalId(resolveModalId(payload.openModalId));
      }

      if (typeof payload.commandId === "string" && payload.commandId.trim().length > 0) {
        void runtime.commands.execute(payload.commandId, ...(payload.args ?? []));
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [runtime, workspaceViews, consoleTabs, modalDialogs]);

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const initial = sidebarWidth;
    const shellBody = event.currentTarget.closest(".shell-body") as HTMLElement | null;
    const onMove = (moveEvent: MouseEvent): void => {
      const maxWidthByViewport = shellBody
        ? Math.max(260, Math.floor(shellBody.getBoundingClientRect().width) - 52 - 4)
        : Number.POSITIVE_INFINITY;
      const next = Math.max(260, Math.min(maxWidthByViewport, initial + (moveEvent.clientX - startX)));
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
    const workspaceColumn = event.currentTarget.closest(".workspace-column") as HTMLElement | null;
    const onMove = (moveEvent: MouseEvent): void => {
      const maxHeightByWorkspace = workspaceColumn
        ? Math.max(120, Math.floor(workspaceColumn.getBoundingClientRect().height) - 32 - 4)
        : Number.POSITIVE_INFINITY;
      const next = Math.max(120, Math.min(maxHeightByWorkspace, initial - (moveEvent.clientY - startY)));
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
  const shellColumns = usingVscodeLayout ? "minmax(0, 1fr)" : shellBodyColumns;

  return (
    <div className="shell">
      <ZoomHost controller={zoomController} />
      <KeybindingHost runtime={runtime} context={keybindingContext} />
      <ToolbarMenu runtime={runtime} menus={toolbarMenus} />
      <div
        className="shell-body"
        style={{
          gridTemplateColumns: shellColumns
        }}
      >
        {usingVscodeLayout ? (
          <WorkspacePanel views={workspaceViews} activeViewId={activeWorkspaceId} onSelectView={setActiveWorkspaceId} />
        ) : (
          <>
            <Panel
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
            <WorkspacePanel views={workspaceViews} activeViewId={activeWorkspaceId} onSelectView={setActiveWorkspaceId}>
              <div
                className={`splitter-horizontal ${consoleCollapsed ? "collapsed" : ""}`}
                onMouseDown={startConsoleResize}
                role="separator"
                aria-orientation="horizontal"
              />
              <ConsolePanel
                tabs={consoleTabs}
                activeTabId={activeConsoleId}
                onSelectTab={setActiveConsoleId}
                collapsed={consoleCollapsed}
                height={consoleCollapsed ? 36 : consoleHeight}
              />
            </WorkspacePanel>
          </>
        )}
      </div>
      <ModalHost dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
      <GlobalDialogHost runtime={runtime} />
      <Footer
        items={footerItems}
        consoleCollapsed={usingVscodeLayout ? true : consoleCollapsed}
        onToggleConsoleCollapse={() => setConsoleCollapsed((prev) => !prev)}
        showConsoleToggle={!usingVscodeLayout}
      />
    </div>
  );
}

import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConsolePanel, Panel, WorkspacePanel } from "../packages/core";
import { useSlot } from "../core/contributions/useSlot";
import type { AppRuntime } from "../core/types/module";
import { ModalHost } from "./layout/ModalHost";
import { GlobalDialogHost } from "./layout/GlobalDialogHost";
import { emitProjection } from "../platform/host/bridge";

export type CockpitWebviewSlot = "full" | "sidebar" | "workspace" | "console";

interface VscodeWebviewShellProps {
  runtime: AppRuntime;
  slot: Exclude<CockpitWebviewSlot, "full">;
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

export function VscodeWebviewShell({ runtime, slot }: VscodeWebviewShellProps): JSX.Element {
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
  const [sidebarWidth, setSidebarWidth] = useState(320);

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
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isHostCommandMessage(event.data)) return;
      const payload = event.data;

      if (payload.activateWorkspaceId) {
        setActiveWorkspaceId(payload.activateWorkspaceId);
      }
      if (payload.activateConsoleId) {
        setActiveConsoleId(payload.activateConsoleId);
      }
      if (payload.openModalId) {
        const direct = payload.openModalId;
        if (modalDialogs.some((dialog) => dialog.id === direct)) {
          setActiveModalId(direct);
        } else {
          const suffix = `.${direct}`;
          const namespaced = modalDialogs.find((dialog) => dialog.id.endsWith(suffix));
          setActiveModalId(namespaced?.id ?? direct);
        }
      }

      if (typeof payload.commandId === "string" && payload.commandId.trim().length > 0) {
        void runtime.commands.execute(payload.commandId, ...(payload.args ?? []));
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [runtime, modalDialogs]);

  const sidebarResizeHandler = useMemo(
    () =>
      (event: ReactMouseEvent<HTMLDivElement>): void => {
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
      },
    [sidebarCollapsed, sidebarWidth]
  );

  if (slot === "sidebar") {
    return (
      <div className="cockpit-slot-shell cockpit-slot-shell-sidebar">
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
          onResizeStart={sidebarResizeHandler}
        />
      </div>
    );
  }

  if (slot === "console") {
    return (
      <div className="cockpit-slot-shell cockpit-slot-shell-console">
        <ConsolePanel
          tabs={consoleTabs}
          activeTabId={activeConsoleId}
          onSelectTab={setActiveConsoleId}
          collapsed={false}
          height={480}
        />
      </div>
    );
  }

  return (
    <div className="cockpit-slot-shell cockpit-slot-shell-workspace">
      <WorkspacePanel views={workspaceViews} activeViewId={activeWorkspaceId} onSelectView={setActiveWorkspaceId} />
      <ModalHost dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
      <GlobalDialogHost runtime={runtime} />
    </div>
  );
}

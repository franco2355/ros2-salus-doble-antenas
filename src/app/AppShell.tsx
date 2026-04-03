import { useEffect, useState } from "react";
import { ConsoleHost } from "./layout/ConsoleHost";
import { ModalHost } from "./layout/ModalHost";
import { SidebarHost } from "./layout/SidebarHost";
import { TopToolbar } from "./layout/TopToolbar";
import { WorkspaceHost } from "./layout/WorkspaceHost";
import type { AppRuntime } from "../core/types/module";

interface AppShellProps {
  runtime: AppRuntime;
}

export function AppShell({ runtime }: AppShellProps): JSX.Element {
  const toolbarMenus = runtime.registries.toolbarMenuRegistry.list();
  const sidebarPanels = runtime.registries.sidebarPanelRegistry.list();
  const workspaceViews = runtime.registries.workspaceViewRegistry.list();
  const consoleTabs = runtime.registries.consoleTabRegistry.list();
  const modalDialogs = runtime.registries.modalRegistry.list();

  const [activeSidebarId, setActiveSidebarId] = useState<string>(sidebarPanels[0]?.id ?? "");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(workspaceViews[0]?.id ?? "");
  const [activeConsoleId, setActiveConsoleId] = useState<string>(consoleTabs[0]?.id ?? "");
  const [activeModalId, setActiveModalId] = useState<string | null>(null);

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

  const activeSidebarPanel = sidebarPanels.find((panel) => panel.id === activeSidebarId) ?? null;
  const activeWorkspace = workspaceViews.find((view) => view.id === activeWorkspaceId) ?? null;

  return (
    <div className="shell">
      <TopToolbar runtime={runtime} menus={toolbarMenus} openModal={setActiveModalId} />
      <div className="shell-body">
        <div className="sidebar-selector">
          {sidebarPanels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={panel.id === activeSidebarId ? "active" : ""}
              onClick={() => setActiveSidebarId(panel.id)}
            >
              {panel.label}
            </button>
          ))}
        </div>
        <SidebarHost runtime={runtime} panel={activeSidebarPanel} />
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
          <ConsoleHost
            runtime={runtime}
            tabs={consoleTabs}
            activeTabId={activeConsoleId}
            onSelectTab={setActiveConsoleId}
          />
        </main>
      </div>
      <ModalHost runtime={runtime} dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
    </div>
  );
}


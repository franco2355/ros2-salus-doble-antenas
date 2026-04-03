import type { AppRuntime } from "../../core/types/module";
import type { SidebarPanelDefinition } from "../../core/types/ui";

interface SidebarHostProps {
  runtime: AppRuntime;
  panel: SidebarPanelDefinition | null;
}

export function SidebarHost({ runtime, panel }: SidebarHostProps): JSX.Element {
  if (!panel) {
    return <aside className="sidebar-panel">No sidebar panel registered.</aside>;
  }
  return <aside className="sidebar-panel">{panel.render(runtime)}</aside>;
}


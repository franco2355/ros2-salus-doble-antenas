import type { ReactNode } from "react";
import type { AppRuntime } from "../../../../../core/types/module";
import type { WorkspaceViewDefinition } from "../../../../../core/types/ui";

interface WorkspacePanelProps {
  runtime: AppRuntime;
  views: WorkspaceViewDefinition[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  children?: ReactNode;
}

export function WorkspacePanel({
  runtime,
  views,
  activeViewId,
  onSelectView,
  children
}: WorkspacePanelProps): JSX.Element {
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  return (
    <main className="workspace-column">
      <section className="workspace-selector">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className={view.id === activeViewId ? "active" : ""}
            onClick={() => onSelectView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </section>
      <section className="workspace-view">
        {activeView ? activeView.render(runtime) : "No workspace view registered."}
      </section>
      {children}
    </main>
  );
}

import type { ReactNode } from "react";
import type { WorkspaceContribution } from "../../../../../core/contributions/types";

interface WorkspacePanelProps {
  views: WorkspaceContribution[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  children?: ReactNode;
}

export function WorkspacePanel({ views, activeViewId, onSelectView, children }: WorkspacePanelProps): JSX.Element {
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  return (
    <main className="workspace-column ws-col">
      <section className="workspace-selector ws-tabs" aria-label="Workspace tabs">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`ws-tab ${view.id === activeViewId ? "active" : ""}`}
            onClick={() => onSelectView(view.id)}
          >
            {view.label}
          </button>
        ))}
        <div className="ws-tab-sp" aria-hidden="true" />
        <button type="button" className="ws-act" title="Split view" aria-label="Split view">⊞</button>
        <button type="button" className="ws-act" title="Fullscreen" aria-label="Fullscreen">⤢</button>
      </section>
      <section className="workspace-view ws-view">
        {activeView ? activeView.render() : "No workspace view registered."}
      </section>
      {children}
    </main>
  );
}

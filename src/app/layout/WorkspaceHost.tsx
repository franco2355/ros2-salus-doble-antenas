import type { AppRuntime } from "../../core/types/module";
import type { WorkspaceViewDefinition } from "../../core/types/ui";

interface WorkspaceHostProps {
  runtime: AppRuntime;
  view: WorkspaceViewDefinition | null;
}

export function WorkspaceHost({ runtime, view }: WorkspaceHostProps): JSX.Element {
  if (!view) {
    return <section className="workspace-view">No workspace view registered.</section>;
  }
  return <section className="workspace-view">{view.render(runtime)}</section>;
}


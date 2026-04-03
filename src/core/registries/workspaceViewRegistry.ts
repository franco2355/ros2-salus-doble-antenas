import type { WorkspaceViewDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class WorkspaceViewRegistry extends OrderedRegistry<WorkspaceViewDefinition> {
  registerWorkspaceView(definition: WorkspaceViewDefinition): void {
    this.register(definition);
  }
}


import type { SidebarPanelDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class SidebarPanelRegistry extends OrderedRegistry<SidebarPanelDefinition> {
  registerSidebarPanel(definition: SidebarPanelDefinition): void {
    this.register(definition);
  }
}


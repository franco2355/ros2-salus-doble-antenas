import type { ToolbarMenuDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class ToolbarMenuRegistry extends OrderedRegistry<ToolbarMenuDefinition> {
  registerToolbarMenu(definition: ToolbarMenuDefinition): void {
    this.register(definition);
  }
}


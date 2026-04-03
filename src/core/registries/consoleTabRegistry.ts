import type { ConsoleTabDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class ConsoleTabRegistry extends OrderedRegistry<ConsoleTabDefinition> {
  registerConsoleTab(definition: ConsoleTabDefinition): void {
    this.register(definition);
  }
}


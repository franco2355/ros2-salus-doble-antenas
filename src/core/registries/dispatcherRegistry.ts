import type { Dispatcher } from "../../dispatcher/base/Dispatcher";
import { OrderedRegistry } from "./orderedRegistry";

export interface DispatcherDefinition {
  id: string;
  order?: number;
  dispatcher: Dispatcher;
}

export class DispatcherRegistry extends OrderedRegistry<DispatcherDefinition> {
  registerDispatcher(definition: DispatcherDefinition): void {
    this.register(definition);
  }
}


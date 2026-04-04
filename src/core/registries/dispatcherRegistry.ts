import type { Dispatcher } from "../../packages/core/modules/runtime/dispatcher/base/Dispatcher";
import { OrderedRegistry } from "./orderedRegistry";

export interface DispatcherDefinition {
  id: string;
  dispatcher: Dispatcher;
}

export class DispatcherRegistry extends OrderedRegistry<DispatcherDefinition> {
  registerDispatcher(definition: DispatcherDefinition): void {
    this.register(definition);
  }
}

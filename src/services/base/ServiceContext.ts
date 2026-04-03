import type { DispatcherRegistry } from "../../core/registries/dispatcherRegistry";
import type { EventBus } from "../../core/events/eventBus";

export interface ServiceContext {
  dispatcherRegistry: DispatcherRegistry;
  eventBus: EventBus;
}


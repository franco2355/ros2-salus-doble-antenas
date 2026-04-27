import { OrderedRegistry } from "./orderedRegistry";

export interface ServiceDefinition<T = unknown> {
  id: string;
  service: T;
}

export class ServiceRegistry extends OrderedRegistry<ServiceDefinition> {
  registerService<T>(definition: ServiceDefinition<T>): void {
    this.register(definition);
  }

  getService<T>(id: string): T {
    const item = this.get(id);
    if (!item) {
      throw new Error(`Service not found: ${id}`);
    }
    return item.service as T;
  }
}

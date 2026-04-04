import type { Transport } from "../../packages/core/transport/base/Transport";
import { OrderedRegistry } from "./orderedRegistry";

export interface TransportDefinition {
  id: string;
  transport: Transport;
}

export class TransportRegistry extends OrderedRegistry<TransportDefinition> {
  registerTransport(definition: TransportDefinition): void {
    this.register(definition);
  }
}

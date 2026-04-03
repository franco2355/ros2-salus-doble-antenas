import type { Transport } from "../../transport/base/Transport";
import { OrderedRegistry } from "./orderedRegistry";

export interface TransportDefinition {
  id: string;
  order?: number;
  transport: Transport;
}

export class TransportRegistry extends OrderedRegistry<TransportDefinition> {
  registerTransport(definition: TransportDefinition): void {
    this.register(definition);
  }
}


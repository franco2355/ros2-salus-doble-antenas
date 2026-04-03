import type { IncomingPacket } from "../../core/types/message";
import { DispatcherBase } from "../base/Dispatcher";

export class MapDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, ["map.request", "map.loaded", "google.maps.geocode.result"]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async requestMap(mapId: string): Promise<IncomingPacket> {
    return this.request("map.request", { mapId }, { timeoutMs: 6000 });
  }

  async geocodeAddress(address: string): Promise<IncomingPacket> {
    return this.request("google.maps.geocode", { address }, { timeoutMs: 5000 });
  }
}


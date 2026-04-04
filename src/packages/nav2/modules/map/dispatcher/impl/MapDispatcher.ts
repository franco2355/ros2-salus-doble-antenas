import type { IncomingPacket } from "../../../../../../core/types/message";
import { DispatcherBase } from "../../../../../core/modules/runtime/dispatcher/base/Dispatcher";

export class MapDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, ["state", "ack", "robot_pose"]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async requestMap(_mapId: string): Promise<IncomingPacket> {
    return this.request("get_state", {}, { timeoutMs: 6000 });
  }

  async setZonesGeoJson(geojson: unknown): Promise<IncomingPacket> {
    return this.request("set_zones_geojson", { geojson } as never, { timeoutMs: 6000 });
  }

  async loadZonesFile(): Promise<IncomingPacket> {
    return this.request("load_zones_file", {}, { timeoutMs: 6000 });
  }

  async setDatum(): Promise<IncomingPacket> {
    return this.request("set_datum", {}, { timeoutMs: 6000 });
  }
}

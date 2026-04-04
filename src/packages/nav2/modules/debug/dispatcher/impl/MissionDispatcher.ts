import type { IncomingPacket } from "../../../../../../core/types/message";
import { DispatcherBase } from "../../../../../core/modules/runtime/dispatcher/base/Dispatcher";

export interface MissionStartRequest {
  missionId: string;
  robotId: string;
}

export interface RosbagStatus {
  active: boolean;
  profile: string;
  outputPath: string;
  logPath: string;
}

export class MissionDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, [
      "ack",
      "rosbag_status",
      "nav_event",
      "mission.start",
      "mission.status.update"
    ]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async startMission(request: MissionStartRequest): Promise<IncomingPacket> {
    return this.request("mission.start", request as never, { timeoutMs: 6000 });
  }

  async startRosbag(profile: string): Promise<IncomingPacket> {
    return this.request("start_rosbag", { profile } as never, { timeoutMs: 6000 });
  }

  async stopRosbag(): Promise<IncomingPacket> {
    return this.request("stop_rosbag", {}, { timeoutMs: 6000 });
  }

  async requestRosbagStatus(): Promise<IncomingPacket> {
    return this.request("get_rosbag_status", {}, { timeoutMs: 4000 });
  }

  subscribeMissionStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("nav_event", callback);
  }

  subscribeRosbagStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("rosbag_status", callback);
  }
}

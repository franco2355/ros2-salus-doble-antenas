import type { IncomingPacket } from "../../core/types/message";
import { DispatcherBase } from "../base/Dispatcher";

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
      "mission.start",
      "mission.start.result",
      "mission.status.update",
      "rosbag.start",
      "rosbag.stop",
      "rosbag.status.get",
      "rosbag.status.update"
    ]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async startMission(request: MissionStartRequest): Promise<IncomingPacket> {
    return this.request("mission.start", request as never, { timeoutMs: 6000 });
  }

  async startRosbag(profile: string): Promise<IncomingPacket> {
    return this.request("rosbag.start", { profile } as never, { timeoutMs: 6000 });
  }

  async stopRosbag(): Promise<IncomingPacket> {
    return this.request("rosbag.stop", {}, { timeoutMs: 6000 });
  }

  async requestRosbagStatus(): Promise<IncomingPacket> {
    return this.request("rosbag.status.get", {}, { timeoutMs: 4000 });
  }

  subscribeMissionStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("mission.status.update", callback);
  }

  subscribeRosbagStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("rosbag.status.update", callback);
  }
}

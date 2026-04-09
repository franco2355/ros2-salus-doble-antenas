import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

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

export class MissionDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  async startMission(request: MissionStartRequest): Promise<Nav2IncomingMessage> {
    return this.request("mission.start", request as never, { timeoutMs: 6000 });
  }

  async startRosbag(): Promise<Nav2IncomingMessage> {
    return this.request("start_record", {}, { timeoutMs: 6000 });
  }

  async stopRosbag(): Promise<Nav2IncomingMessage> {
    return this.request("stop_record", {}, { timeoutMs: 6000 });
  }

  async requestRosbagStatus(): Promise<Nav2IncomingMessage> {
    return this.request("get_rosbag_status", {}, { timeoutMs: 4000 });
  }

  subscribeMissionStatus(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("nav_event", callback);
  }

  subscribeRosbagStatus(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("rosbag_status", callback);
  }
}

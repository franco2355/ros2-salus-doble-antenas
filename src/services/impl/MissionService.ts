import type { MissionDispatcher } from "../../dispatcher/impl/MissionDispatcher";
import type { MissionStartRequest } from "../../dispatcher/impl/MissionDispatcher";
import type { RosbagStatus } from "../../dispatcher/impl/MissionDispatcher";

export class MissionService {
  constructor(private readonly missionDispatcher: MissionDispatcher) {}

  async startMission(input: MissionStartRequest): Promise<void> {
    if (!input.missionId.trim() || !input.robotId.trim()) {
      throw new Error("missionId and robotId are required");
    }
    const response = await this.missionDispatcher.startMission(input);
    if (response.ok === false) {
      throw new Error(response.error ?? "Mission start failed");
    }
  }

  subscribeMissionStatus(callback: (text: string) => void): () => void {
    return this.missionDispatcher.subscribeMissionStatus((message) => {
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      callback(String(payload.status ?? "unknown"));
    });
  }

  async startRosbag(profile: string): Promise<RosbagStatus> {
    if (!profile.trim()) {
      throw new Error("profile is required");
    }
    const response = await this.missionDispatcher.startRosbag(profile.trim());
    if (response.ok === false) {
      throw new Error(response.error ?? "Start rosbag failed");
    }
    return this.parseRosbagStatus(response.payload);
  }

  async stopRosbag(): Promise<RosbagStatus> {
    const response = await this.missionDispatcher.stopRosbag();
    if (response.ok === false) {
      throw new Error(response.error ?? "Stop rosbag failed");
    }
    return this.parseRosbagStatus(response.payload);
  }

  async getRosbagStatus(): Promise<RosbagStatus> {
    const response = await this.missionDispatcher.requestRosbagStatus();
    if (response.ok === false) {
      throw new Error(response.error ?? "Rosbag status failed");
    }
    return this.parseRosbagStatus(response.payload);
  }

  subscribeRosbagStatus(callback: (status: RosbagStatus) => void): () => void {
    return this.missionDispatcher.subscribeRosbagStatus((message) => {
      callback(this.parseRosbagStatus(message.payload));
    });
  }

  private parseRosbagStatus(payload: unknown): RosbagStatus {
    const value = (payload ?? {}) as Record<string, unknown>;
    return {
      active: value.active === true,
      profile: String(value.profile ?? "core"),
      outputPath: String(value.outputPath ?? "n/a"),
      logPath: String(value.logPath ?? "n/a")
    };
  }
}

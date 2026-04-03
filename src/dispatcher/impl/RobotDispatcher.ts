import type { IncomingPacket, MessagePayload } from "../../core/types/message";
import { DispatcherBase } from "../base/Dispatcher";

export interface RobotStatus {
  batteryPct: number;
  mode: string;
  connected: boolean;
}

export class RobotDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, [
      "robot.status.update",
      "robot.pose.update",
      "navigation.goal.result",
      "navigation.goal.send",
      "navigation.goal.cancel",
      "robot.manual_mode.set",
      "robot.manual_cmd.send",
      "navigation.snapshot.get",
      "camera.pan",
      "camera.zoom.toggle",
      "camera.status.get"
    ]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async requestGoal(goal: MessagePayload): Promise<IncomingPacket> {
    return this.request("navigation.goal.send", goal, { timeoutMs: 5000 });
  }

  async requestCancelGoal(): Promise<IncomingPacket> {
    return this.request("navigation.goal.cancel", {}, { timeoutMs: 5000 });
  }

  async requestManualMode(enabled: boolean): Promise<IncomingPacket> {
    return this.request("robot.manual_mode.set", { enabled } as never, { timeoutMs: 5000 });
  }

  async requestManualCommand(linearX: number, angularZ: number, brake: boolean): Promise<IncomingPacket> {
    return this.request(
      "robot.manual_cmd.send",
      {
        linearX,
        angularZ,
        brake
      } as never,
      { timeoutMs: 2500 }
    );
  }

  async requestSnapshot(): Promise<IncomingPacket> {
    return this.request("navigation.snapshot.get", {}, { timeoutMs: 7000 });
  }

  async requestCameraPan(angleDeg: number): Promise<IncomingPacket> {
    return this.request("camera.pan", { angleDeg } as never, { timeoutMs: 4000 });
  }

  async requestCameraZoomToggle(): Promise<IncomingPacket> {
    return this.request("camera.zoom.toggle", {}, { timeoutMs: 4000 });
  }

  async requestCameraStatus(): Promise<IncomingPacket> {
    return this.request("camera.status.get", {}, { timeoutMs: 4000 });
  }

  subscribeRobotStatus(callback: (status: RobotStatus) => void): () => void {
    return this.subscribe("robot.status.update", (message) => {
      callback((message.payload ?? {}) as unknown as RobotStatus);
    });
  }
}

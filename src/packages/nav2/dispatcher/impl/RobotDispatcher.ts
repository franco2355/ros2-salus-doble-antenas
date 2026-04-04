import type { IncomingPacket, MessagePayload } from "../../../../core/types/message";
import { DispatcherBase } from "../../../core/dispatcher/base/Dispatcher";

export interface RobotStatus {
  batteryPct: number;
  mode: string;
  connected: boolean;
}

export class RobotDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, [
      "state",
      "robot_pose",
      "nav_telemetry",
      "nav_event",
      "nav_alerts",
      "nav_snapshot",
      "camera_status",
      "sensor_info",
      "ack"
    ]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async requestGoal(goal: MessagePayload): Promise<IncomingPacket> {
    return this.request("set_goal_ll", goal, { timeoutMs: 5000 });
  }

  async requestCancelGoal(): Promise<IncomingPacket> {
    return this.request("cancel_goal", {}, { timeoutMs: 5000 });
  }

  async requestManualMode(enabled: boolean): Promise<IncomingPacket> {
    return this.request("set_manual_mode", { enabled } as never, { timeoutMs: 5000 });
  }

  async requestManualCommand(linearX: number, angularZ: number, brake: boolean): Promise<IncomingPacket> {
    // Legacy backend contract expects snake_case controls at top level.
    return this.request(
      "set_manual_cmd",
      {
        linear_x: linearX,
        angular_z: angularZ,
        brake_pct: brake ? 100 : 0
      } as never,
      { timeoutMs: 2500 }
    );
  }

  async requestSnapshot(): Promise<IncomingPacket> {
    return this.request("get_nav_snapshot", {}, { timeoutMs: 7000 });
  }

  async requestSaveWaypointsFile(waypoints: Array<{ lat: number; lon: number; yaw_deg: number }>): Promise<IncomingPacket> {
    return this.request("save_waypoints_file", { waypoints } as never, { timeoutMs: 7000 });
  }

  async requestLoadWaypointsFile(): Promise<IncomingPacket> {
    return this.request("load_waypoints_file", {}, { timeoutMs: 7000 });
  }

  async requestCameraPan(angleDeg: number): Promise<IncomingPacket> {
    return this.request("camera_pan", { angle: angleDeg } as never, { timeoutMs: 4000 });
  }

  async requestCameraZoomToggle(): Promise<IncomingPacket> {
    return this.request("camera_zoom_toggle", {}, { timeoutMs: 4000 });
  }

  async requestCameraStatus(): Promise<IncomingPacket> {
    return this.request("get_camera_status", {}, { timeoutMs: 4000 });
  }

  async requestState(): Promise<IncomingPacket> {
    return this.request("get_state", {}, { timeoutMs: 5000 });
  }

  async requestControlLock(locked: boolean): Promise<IncomingPacket> {
    return this.request("set_control_lock", { locked } as never, { timeoutMs: 5000 });
  }

  async requestControlHeartbeat(): Promise<IncomingPacket> {
    return this.request("control_heartbeat", {}, { timeoutMs: 3000 });
  }

  async requestSensorInfoView(input: {
    enabled: boolean;
    tab: string | null;
    intervalS: number;
    topicName?: string | null;
  }): Promise<IncomingPacket> {
    return this.request(
      "set_sensor_info_view",
      {
        enabled: input.enabled,
        tab: input.tab,
        interval_s: input.intervalS,
        topic_name: input.topicName ?? null
      } as never,
      { timeoutMs: 5000 }
    );
  }

  subscribeRobotStatus(callback: (status: RobotStatus) => void): () => void {
    return this.subscribe("nav_telemetry", (message) => {
      const connected = message.connected === true || message.ok === true;
      callback({
        connected,
        mode: String(message.mode ?? (connected ? "connected" : "disconnected")),
        batteryPct: Number(message.battery_pct ?? 0)
      });
    });
  }

  subscribeState(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("state", callback);
  }

  subscribeNavTelemetry(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("nav_telemetry", callback);
  }

  subscribeNavEvent(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("nav_event", callback);
  }

  subscribeNavAlerts(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("nav_alerts", callback);
  }

  subscribeRobotPose(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("robot_pose", callback);
  }

  subscribeSensorInfo(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("sensor_info", callback);
  }

  subscribeAck(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("ack", callback);
  }
}

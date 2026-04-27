import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

export interface RobotStatus {
  batteryPct: number;
  mode: string;
  connected: boolean;
}

export class RobotDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  async requestGoal(goal: unknown): Promise<Nav2IncomingMessage> {
    return this.request("set_goal_ll", goal, { timeoutMs: 5000 });
  }

  async requestRouteMission(goal: unknown): Promise<Nav2IncomingMessage> {
    return this.request("set_route_ll", goal, { timeoutMs: 7000 });
  }

  async requestCancelGoal(): Promise<Nav2IncomingMessage> {
    return this.request("cancel_goal", {}, { timeoutMs: 5000 });
  }

  async requestCancelRouteMission(): Promise<Nav2IncomingMessage> {
    return this.request("cancel_route", {}, { timeoutMs: 5000 });
  }

  async requestManualMode(enabled: boolean): Promise<Nav2IncomingMessage> {
    return this.request("set_manual_mode", { enabled } as never, { timeoutMs: 5000 });
  }

  async requestManualCommand(linearX: number, angularZ: number, brake: boolean): Promise<Nav2IncomingMessage> {
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

  async requestSnapshot(): Promise<Nav2IncomingMessage> {
    return this.request("get_nav_snapshot", {}, { timeoutMs: 7000 });
  }

  async requestSaveWaypointsFile(
    waypoints: Array<{ lat: number; lon: number; yaw_deg: number }>
  ): Promise<Nav2IncomingMessage> {
    return this.request("save_waypoints_file", { waypoints } as never, { timeoutMs: 7000 });
  }

  async requestLoadWaypointsFile(): Promise<Nav2IncomingMessage> {
    return this.request("load_waypoints_file", {}, { timeoutMs: 7000 });
  }

  async requestStartRecording(): Promise<Nav2IncomingMessage> {
    return this.request("start_recording", {}, { timeoutMs: 5000 });
  }

  async requestStopRecording(): Promise<Nav2IncomingMessage> {
    return this.request("stop_recording", {}, { timeoutMs: 7000 });
  }

  async requestClearRecording(): Promise<Nav2IncomingMessage> {
    return this.request("clear_recording", {}, { timeoutMs: 5000 });
  }

  async requestStartPatrol(): Promise<Nav2IncomingMessage> {
    return this.request("start_patrol", {}, { timeoutMs: 5000 });
  }

  async requestStopPatrol(): Promise<Nav2IncomingMessage> {
    return this.request("stop_patrol", {}, { timeoutMs: 5000 });
  }

  async requestCameraPan(angleDeg: number): Promise<Nav2IncomingMessage> {
    return this.request("camera_pan", { angle: angleDeg } as never, { timeoutMs: 4000 });
  }

  async requestCameraZoomToggle(): Promise<Nav2IncomingMessage> {
    return this.request("camera_zoom_toggle", {}, { timeoutMs: 4000 });
  }

  async requestCameraStatus(): Promise<Nav2IncomingMessage> {
    return this.request("get_camera_status", {}, { timeoutMs: 4000 });
  }

  async requestState(): Promise<Nav2IncomingMessage> {
    return this.request("get_state", {}, { timeoutMs: 5000 });
  }

  async requestControlLock(locked: boolean): Promise<Nav2IncomingMessage> {
    return this.request("set_control_lock", { locked } as never, { timeoutMs: 5000 });
  }

  async requestControlHeartbeat(): Promise<Nav2IncomingMessage> {
    return this.request("control_heartbeat", {}, { timeoutMs: 3000 });
  }

  async requestSensorInfoView(input: {
    enabled: boolean;
    tab: string | null;
    intervalS: number;
    topicName?: string | null;
  }): Promise<Nav2IncomingMessage> {
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

  subscribeState(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("state", callback);
  }

  subscribeNavTelemetry(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("nav_telemetry", callback);
  }

  subscribeNavEvent(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("nav_event", callback);
  }

  subscribeRecordingCount(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("recording_count", callback);
  }

  subscribePatrolStatus(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("patrol_status", callback);
  }

  subscribeNavAlerts(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("nav_alerts", callback);
  }

  subscribeRobotPose(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("robot_pose", callback);
  }

  subscribeSensorInfo(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("sensor_info", callback);
  }

  subscribeAck(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("ack", callback);
  }
}

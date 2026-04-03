import type { MessagePayload } from "../../core/types/message";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";

export interface GoalInput {
  x: number;
  y: number;
  yawDeg: number;
}

export interface ManualCommandInput {
  linearX: number;
  angularZ: number;
  brake: boolean;
}

export interface SnapshotData {
  mime: string;
  imageBase64: string;
  stamp: number;
}

export interface CameraStatusData {
  ok: boolean;
  error: string;
  zoomIn: boolean;
  lastCommand: string;
}

export class NavigationService {
  constructor(private readonly robotDispatcher: RobotDispatcher) {}

  async sendGoal(input: GoalInput): Promise<void> {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.yawDeg)) {
      throw new Error("Invalid goal input");
    }

    const payload: MessagePayload = {
      x: Number(input.x),
      y: Number(input.y),
      yawDeg: Number(input.yawDeg)
    } as never;

    const response = await this.robotDispatcher.requestGoal(payload);
    if (response.ok === false) {
      throw new Error(response.error ?? "Goal dispatch failed");
    }
  }

  async cancelGoal(): Promise<void> {
    const response = await this.robotDispatcher.requestCancelGoal();
    if (response.ok === false) {
      throw new Error(response.error ?? "Cancel goal failed");
    }
  }

  async setManualMode(enabled: boolean): Promise<void> {
    const response = await this.robotDispatcher.requestManualMode(enabled);
    if (response.ok === false) {
      throw new Error(response.error ?? "Set manual mode failed");
    }
  }

  async sendManualCommand(input: ManualCommandInput): Promise<void> {
    if (!Number.isFinite(input.linearX) || !Number.isFinite(input.angularZ)) {
      throw new Error("Invalid manual command input");
    }
    const response = await this.robotDispatcher.requestManualCommand(
      Number(input.linearX),
      Number(input.angularZ),
      Boolean(input.brake)
    );
    if (response.ok === false) {
      throw new Error(response.error ?? "Manual command failed");
    }
  }

  async requestSnapshot(): Promise<SnapshotData> {
    const response = await this.robotDispatcher.requestSnapshot();
    if (response.ok === false) {
      throw new Error(response.error ?? "Snapshot request failed");
    }
    const payload = (response.payload ?? {}) as Record<string, unknown>;
    return {
      mime: String(payload.mime ?? "image/png"),
      imageBase64: String(payload.imageBase64 ?? ""),
      stamp: Number(payload.stamp ?? Date.now())
    };
  }

  async panCamera(angleDeg: number): Promise<void> {
    if (!Number.isFinite(angleDeg)) {
      throw new Error("Invalid camera angle");
    }
    const response = await this.robotDispatcher.requestCameraPan(Number(angleDeg));
    if (response.ok === false) {
      throw new Error(response.error ?? "Camera pan failed");
    }
  }

  async toggleCameraZoom(): Promise<void> {
    const response = await this.robotDispatcher.requestCameraZoomToggle();
    if (response.ok === false) {
      throw new Error(response.error ?? "Camera zoom toggle failed");
    }
  }

  async readCameraStatus(): Promise<CameraStatusData> {
    const response = await this.robotDispatcher.requestCameraStatus();
    if (response.ok === false) {
      throw new Error(response.error ?? "Camera status failed");
    }
    const payload = (response.payload ?? {}) as Record<string, unknown>;
    return {
      ok: payload.ok === true,
      error: String(payload.error ?? ""),
      zoomIn: payload.zoomIn === true,
      lastCommand: String(payload.lastCommand ?? "none")
    };
  }
}

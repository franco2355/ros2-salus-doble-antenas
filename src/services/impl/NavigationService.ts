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

export interface NavigationState {
  waypoints: GoalInput[];
  loopRoute: boolean;
  manualMode: boolean;
  cameraStreamConnected: boolean;
  lastStatus: string;
  lastSnapshot: SnapshotData | null;
}

type NavigationListener = (state: NavigationState) => void;

const WAYPOINT_STORAGE_KEY = "cockpit.navigation.waypoints.v1";
const navigationMemoryStorage = new Map<string, string>();

function getStorageAdapter(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  if (
    typeof window !== "undefined" &&
    window.localStorage &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function"
  ) {
    return window.localStorage;
  }
  return {
    getItem: (key: string) => (navigationMemoryStorage.has(key) ? navigationMemoryStorage.get(key)! : null),
    setItem: (key: string, value: string) => {
      navigationMemoryStorage.set(key, value);
    }
  };
}

function parseGoal(input: GoalInput): GoalInput {
  const parsed = {
    x: Number(input.x),
    y: Number(input.y),
    yawDeg: Number(input.yawDeg)
  };
  if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y) || !Number.isFinite(parsed.yawDeg)) {
    throw new Error("Invalid goal input");
  }
  return parsed;
}

function parseStoredWaypoints(raw: string): GoalInput[] {
  const parsed = JSON.parse(raw) as GoalInput[];
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid waypoint payload");
  }
  return parsed.map((entry) => parseGoal(entry)).slice(0, 40);
}

export class NavigationService {
  private readonly listeners = new Set<NavigationListener>();
  private state: NavigationState = {
    waypoints: [],
    loopRoute: true,
    manualMode: false,
    cameraStreamConnected: false,
    lastStatus: "No active goal",
    lastSnapshot: null
  };

  constructor(private readonly robotDispatcher: RobotDispatcher) {}

  getState(): NavigationState {
    return {
      ...this.state,
      waypoints: this.state.waypoints.map((waypoint) => ({ ...waypoint })),
      lastSnapshot: this.state.lastSnapshot ? { ...this.state.lastSnapshot } : null
    };
  }

  subscribe(listener: NavigationListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLoopRoute(enabled: boolean): void {
    this.state = {
      ...this.state,
      loopRoute: enabled
    };
    this.emit();
  }

  queueWaypoint(input: GoalInput): void {
    const parsed = parseGoal(input);
    this.state = {
      ...this.state,
      waypoints: [...this.state.waypoints, parsed].slice(-40),
      lastStatus: "Waypoint added"
    };
    this.emit();
  }

  removeLastWaypoint(): void {
    this.state = {
      ...this.state,
      waypoints: this.state.waypoints.slice(0, Math.max(0, this.state.waypoints.length - 1)),
      lastStatus: "Waypoint removed"
    };
    this.emit();
  }

  clearWaypoints(): void {
    this.state = {
      ...this.state,
      waypoints: [],
      lastStatus: "Waypoints cleared"
    };
    this.emit();
  }

  saveWaypoints(): number {
    getStorageAdapter().setItem(WAYPOINT_STORAGE_KEY, JSON.stringify(this.state.waypoints));
    this.state = {
      ...this.state,
      lastStatus: `Saved ${this.state.waypoints.length} waypoints`
    };
    this.emit();
    return this.state.waypoints.length;
  }

  loadWaypoints(): number {
    const raw = getStorageAdapter().getItem(WAYPOINT_STORAGE_KEY);
    if (!raw) {
      this.state = {
        ...this.state,
        lastStatus: "No saved waypoints"
      };
      this.emit();
      return 0;
    }
    const loaded = parseStoredWaypoints(raw);
    this.state = {
      ...this.state,
      waypoints: loaded,
      lastStatus: `Loaded ${loaded.length} waypoints`
    };
    this.emit();
    return loaded.length;
  }

  toggleCameraStream(): boolean {
    const next = !this.state.cameraStreamConnected;
    this.state = {
      ...this.state,
      cameraStreamConnected: next
    };
    this.emit();
    return next;
  }

  async sendQueuedGoal(fallback?: GoalInput): Promise<{ sentCount: number; loopRoute: boolean }> {
    const source = this.state.waypoints.length > 0 ? this.state.waypoints[0] : fallback;
    if (!source) {
      throw new Error("No waypoint queued");
    }
    await this.sendGoal(source);
    const sentCount = this.state.waypoints.length > 0 ? this.state.waypoints.length : 1;
    this.state = {
      ...this.state,
      lastStatus:
        sentCount > 1 && this.state.loopRoute
          ? `Route sent (${sentCount}) · loop ON`
          : sentCount > 1
            ? `Route sent (${sentCount})`
            : "Goal sent"
    };
    this.emit();
    return {
      sentCount,
      loopRoute: this.state.loopRoute
    };
  }

  async sendGoal(input: GoalInput): Promise<void> {
    const validated = parseGoal(input);
    const payload: MessagePayload = {
      x: validated.x,
      y: validated.y,
      yawDeg: validated.yawDeg
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
    this.state = {
      ...this.state,
      lastStatus: "Goal cancelled"
    };
    this.emit();
  }

  async setManualMode(enabled: boolean): Promise<void> {
    const response = await this.robotDispatcher.requestManualMode(enabled);
    if (response.ok === false) {
      throw new Error(response.error ?? "Set manual mode failed");
    }
    this.state = {
      ...this.state,
      manualMode: enabled,
      lastStatus: enabled ? "Manual mode ON" : "Manual mode OFF"
    };
    this.emit();
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
    const snapshot: SnapshotData = {
      mime: String(payload.mime ?? "image/png"),
      imageBase64: String(payload.imageBase64 ?? ""),
      stamp: Number(payload.stamp ?? Date.now())
    };
    this.state = {
      ...this.state,
      lastSnapshot: snapshot
    };
    this.emit();
    return snapshot;
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

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

import type { MessagePayload } from "../../../../core/types/message";
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

export interface ManualKeysState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
}

export interface NavigationState {
  waypoints: GoalInput[];
  selectedWaypointIndexes: number[];
  loopRoute: boolean;
  goalMode: boolean;
  manualMode: boolean;
  manualDisablePending: boolean;
  manualLinearSpeed: number;
  manualAngularSpeed: number;
  manualCommand: {
    linearX: number;
    angularZ: number;
  };
  manualKeys: ManualKeysState;
  manualBrakeHeld: boolean;
  cameraStreamConnected: boolean;
  controlLocked: boolean;
  controlLockReason: string;
  unlockGraceUntilMs: number;
  lastStatus: string;
  lastSnapshot: SnapshotData | null;
}

type NavigationListener = (state: NavigationState) => void;

const WAYPOINT_STORAGE_KEY = "cockpit.navigation.waypoints.v1";
const DEFAULT_MANUAL_LINEAR_SPEED = 1.2;
const DEFAULT_MANUAL_ANGULAR_SPEED = 0.4;
const MANUAL_LOOP_INTERVAL_MS = 50;
const navigationMemoryStorage = new Map<string, string>();

export interface NavigationManualDefaults {
  linearSpeed: number;
  angularSpeed: number;
  loopIntervalMs: number;
}

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

function sanitizeSelection(selection: number[], max: number): number[] {
  const next = selection
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < max);
  return Array.from(new Set(next)).sort((a, b) => a - b);
}

function parseSnapshotStamp(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && Number.isFinite(Number(raw))) return Number(raw);
  if (typeof raw === "object" && raw !== null) {
    const sec = Number((raw as { sec?: unknown }).sec ?? 0);
    const nanosec = Number((raw as { nanosec?: unknown }).nanosec ?? 0);
    if (Number.isFinite(sec) && Number.isFinite(nanosec)) {
      return sec * 1000 + Math.floor(nanosec / 1_000_000);
    }
  }
  return Date.now();
}

export class NavigationService {
  private readonly listeners = new Set<NavigationListener>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private manualLoopTimer: ReturnType<typeof setInterval> | null = null;
  private readonly manualLoopIntervalMs: number;
  private state: NavigationState = {
    waypoints: [],
    selectedWaypointIndexes: [],
    loopRoute: true,
    goalMode: false,
    manualMode: false,
    manualDisablePending: false,
    manualLinearSpeed: DEFAULT_MANUAL_LINEAR_SPEED,
    manualAngularSpeed: DEFAULT_MANUAL_ANGULAR_SPEED,
    manualCommand: {
      linearX: 0,
      angularZ: 0
    },
    manualKeys: {
      w: false,
      a: false,
      s: false,
      d: false
    },
    manualBrakeHeld: false,
    cameraStreamConnected: false,
    controlLocked: true,
    controlLockReason: "locked",
    unlockGraceUntilMs: 0,
    lastStatus: "No active goal",
    lastSnapshot: null
  };

  constructor(private readonly robotDispatcher: RobotDispatcher, manualDefaults?: Partial<NavigationManualDefaults>) {
    const linearSpeed = Number(manualDefaults?.linearSpeed);
    const angularSpeed = Number(manualDefaults?.angularSpeed);
    const loopIntervalMs = Number(manualDefaults?.loopIntervalMs);
    const safeLinearSpeed = Number.isFinite(linearSpeed) ? linearSpeed : DEFAULT_MANUAL_LINEAR_SPEED;
    const safeAngularSpeed = Number.isFinite(angularSpeed) ? angularSpeed : DEFAULT_MANUAL_ANGULAR_SPEED;
    this.manualLoopIntervalMs =
      Number.isFinite(loopIntervalMs) && loopIntervalMs > 0 ? Math.max(20, Math.round(loopIntervalMs)) : MANUAL_LOOP_INTERVAL_MS;

    this.state = {
      ...this.state,
      manualLinearSpeed: safeLinearSpeed,
      manualAngularSpeed: safeAngularSpeed
    };

    const dispatcher = this.robotDispatcher as unknown as {
      subscribeState?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribeNavTelemetry?: (callback: (message: Record<string, unknown>) => void) => () => void;
    };
    dispatcher.subscribeState?.((message) => {
      this.applyControlLockPayload(message);
      this.applyManualControlPayload(message);
    });
    dispatcher.subscribeNavTelemetry?.((message) => {
      this.applyControlLockPayload(message);
      this.applyManualControlPayload(message);
    });
  }

  getState(): NavigationState {
    return {
      ...this.state,
      waypoints: this.state.waypoints.map((waypoint) => ({ ...waypoint })),
      selectedWaypointIndexes: [...this.state.selectedWaypointIndexes],
      manualCommand: { ...this.state.manualCommand },
      manualKeys: { ...this.state.manualKeys },
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

  toggleGoalMode(): boolean {
    const next = !this.state.goalMode;
    this.state = {
      ...this.state,
      goalMode: next,
      lastStatus: next ? "Goal mode ON" : "Goal mode OFF"
    };
    this.emit();
    return next;
  }

  queueWaypoint(input: GoalInput): void {
    const parsed = parseGoal(input);
    this.state = {
      ...this.state,
      waypoints: [...this.state.waypoints, parsed].slice(-40),
      selectedWaypointIndexes: [],
      lastStatus: "Waypoint added"
    };
    this.emit();
  }

  moveWaypoint(index: number, x: number, y: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.waypoints.length) return;
    const current = this.state.waypoints[index];
    const next = parseGoal({
      x,
      y,
      yawDeg: current.yawDeg
    });
    const waypoints = this.state.waypoints.map((entry, entryIndex) => (entryIndex === index ? next : entry));
    this.state = {
      ...this.state,
      waypoints,
      lastStatus: `Waypoint ${index + 1} moved`
    };
    this.emit();
  }

  removeLastWaypoint(): void {
    this.state = {
      ...this.state,
      waypoints: this.state.waypoints.slice(0, Math.max(0, this.state.waypoints.length - 1)),
      selectedWaypointIndexes: sanitizeSelection(this.state.selectedWaypointIndexes, this.state.waypoints.length - 1),
      lastStatus: "Waypoint removed"
    };
    this.emit();
  }

  clearWaypoints(): void {
    this.state = {
      ...this.state,
      waypoints: [],
      selectedWaypointIndexes: [],
      lastStatus: "Waypoints cleared"
    };
    this.emit();
  }

  toggleWaypointSelection(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.waypoints.length) return;
    const selected = new Set(this.state.selectedWaypointIndexes);
    if (selected.has(index)) {
      selected.delete(index);
    } else {
      selected.add(index);
    }
    this.state = {
      ...this.state,
      selectedWaypointIndexes: sanitizeSelection([...selected], this.state.waypoints.length)
    };
    this.emit();
  }

  selectAllWaypoints(): void {
    const selected = this.state.waypoints.map((_, index) => index);
    this.state = {
      ...this.state,
      selectedWaypointIndexes: selected
    };
    this.emit();
  }

  clearWaypointSelection(): void {
    if (this.state.selectedWaypointIndexes.length === 0) return;
    this.state = {
      ...this.state,
      selectedWaypointIndexes: []
    };
    this.emit();
  }

  removeSelectedWaypoints(): number {
    const selection = new Set(this.state.selectedWaypointIndexes);
    if (selection.size === 0) return 0;
    const nextWaypoints = this.state.waypoints.filter((_, index) => !selection.has(index));
    const removed = this.state.waypoints.length - nextWaypoints.length;
    this.state = {
      ...this.state,
      waypoints: nextWaypoints,
      selectedWaypointIndexes: [],
      lastStatus: removed > 0 ? `Removed ${removed} waypoint${removed > 1 ? "s" : ""}` : this.state.lastStatus
    };
    this.emit();
    return removed;
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

  async saveWaypointsFile(): Promise<number> {
    if (this.state.waypoints.length === 0) {
      throw new Error("No waypoints to save");
    }
    const waypoints = this.state.waypoints.map((entry) => ({
      lat: Number(entry.x),
      lon: Number(entry.y),
      yaw_deg: Number(entry.yawDeg ?? 0)
    }));
    const response = await this.robotDispatcher.requestSaveWaypointsFile(waypoints);
    if (response.ok === false) {
      throw new Error(response.error ?? "Save waypoints failed");
    }
    const count = Number(response.waypoint_count ?? waypoints.length);
    this.state = {
      ...this.state,
      lastStatus: `Waypoints saved (${Number.isFinite(count) ? count : waypoints.length})`
    };
    this.emit();
    return Number.isFinite(count) ? count : waypoints.length;
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
      selectedWaypointIndexes: [],
      lastStatus: `Loaded ${loaded.length} waypoints`
    };
    this.emit();
    return loaded.length;
  }

  async loadWaypointsFile(): Promise<number> {
    const response = await this.robotDispatcher.requestLoadWaypointsFile();
    if (response.ok === false) {
      throw new Error(response.error ?? "Load waypoints failed");
    }
    const raw = Array.isArray(response.waypoints) ? response.waypoints : [];
    const loaded = raw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const value = entry as Record<string, unknown>;
        const lat = Number(value.lat);
        const lon = Number(value.lon);
        const yawDeg = Number(value.yaw_deg ?? value.yawDeg ?? 0);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) {
          return null;
        }
        return {
          x: lat,
          y: lon,
          yawDeg
        } satisfies GoalInput;
      })
      .filter((entry): entry is GoalInput => entry !== null)
      .slice(0, 40);

    this.state = {
      ...this.state,
      waypoints: loaded,
      selectedWaypointIndexes: [],
      lastStatus: `Waypoints loaded (${loaded.length})`
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

  setCameraStreamConnected(connected: boolean): void {
    const next = connected === true;
    if (this.state.cameraStreamConnected === next) return;
    this.state = {
      ...this.state,
      cameraStreamConnected: next
    };
    this.emit();
  }

  async lockControls(): Promise<void> {
    await this.setControlLock(true);
  }

  async unlockControls(graceMs = 2000): Promise<void> {
    await this.setControlLock(false, graceMs);
  }

  startControlHeartbeat(intervalMs = 1000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.robotDispatcher.requestControlHeartbeat().catch(() => undefined);
    }, Math.max(300, intervalMs));
  }

  stopControlHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async sendQueuedGoal(fallback?: GoalInput): Promise<{ sentCount: number; loopRoute: boolean }> {
    if (this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
    if (this.state.manualMode) {
      this.state = {
        ...this.state,
        manualDisablePending: true,
        lastStatus: "Disabling manual mode to send goal..."
      };
      this.emit();
      await this.setManualMode(false);
    }

    const queued = this.state.waypoints.length > 0 ? this.state.waypoints : fallback ? [fallback] : [];
    if (queued.length === 0) {
      throw new Error("No waypoint queued");
    }

    const waypoints = queued.map((entry) => parseGoal(entry)).map((entry) => ({
      lat: entry.x,
      lon: entry.y,
      yaw_deg: entry.yawDeg
    }));
    const response = await this.robotDispatcher.requestGoal({
      waypoints,
      loop: this.state.loopRoute
    } as never);
    if (response.ok === false) {
      throw new Error(String(response.error ?? "Goal dispatch failed"));
    }

    const sentCount = waypoints.length;
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
    if (this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
    const validated = parseGoal(input);
    const payload: MessagePayload = {
      waypoints: [
        {
          lat: validated.x,
          lon: validated.y,
          yaw_deg: validated.yawDeg
        }
      ],
      loop: this.state.loopRoute
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
    if (enabled && this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
    const response = await this.robotDispatcher.requestManualMode(enabled);
    if (response.ok === false) {
      throw new Error(response.error ?? "Set manual mode failed");
    }
    this.state = {
      ...this.state,
      manualMode: enabled,
      manualDisablePending: false,
      lastStatus: enabled ? "Manual mode ON" : "Manual mode OFF"
    };
    if (!enabled) {
      this.clearManualIntent();
    }
    this.updateManualLoopLifecycle();
    this.emit();
  }

  async sendManualCommand(input: ManualCommandInput): Promise<void> {
    if (this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
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
    const payload = ((response.payload as Record<string, unknown> | undefined) ?? response) as Record<string, unknown>;
    const snapshot: SnapshotData = {
      mime: String(payload.mime ?? "image/png"),
      imageBase64: String(payload.image_b64 ?? payload.imageBase64 ?? ""),
      stamp: Number(payload.stamp_ms ?? 0) || parseSnapshotStamp(payload.stamp)
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
    const payload = ((response.payload as Record<string, unknown> | undefined) ?? response) as Record<string, unknown>;
    return {
      ok: payload.ok === true || payload.error == null,
      error: String(payload.error ?? ""),
      zoomIn: payload.zoom_in === true || payload.zoomIn === true,
      lastCommand: String(payload.last_command ?? payload.lastCommand ?? "none")
    };
  }

  setManualLinearSpeed(value: number): void {
    const clamped = Math.min(4, Math.max(0.1, Number(value)));
    if (!Number.isFinite(clamped)) return;
    this.state = {
      ...this.state,
      manualLinearSpeed: clamped
    };
    this.emit();
  }

  setManualAngularSpeed(value: number): void {
    const clamped = Math.min(1.2, Math.max(0.1, Number(value)));
    if (!Number.isFinite(clamped)) return;
    this.state = {
      ...this.state,
      manualAngularSpeed: clamped
    };
    this.emit();
  }

  setManualKeyState(key: keyof ManualKeysState, pressed: boolean): void {
    const nextPressed = pressed === true;
    if (this.state.manualKeys[key] === nextPressed) return;
    this.state = {
      ...this.state,
      manualKeys: {
        ...this.state.manualKeys,
        [key]: nextPressed
      }
    };
    this.updateManualLoopLifecycle();
    this.emit();
    if (nextPressed) {
      this.autoEnableManualModeFromTeleop();
    }
  }

  setManualBrakeHeld(pressed: boolean): void {
    const nextPressed = pressed === true;
    if (this.state.manualBrakeHeld === nextPressed) return;
    this.state = {
      ...this.state,
      manualBrakeHeld: nextPressed
    };
    this.updateManualLoopLifecycle();
    this.emit();
    if (nextPressed) {
      this.autoEnableManualModeFromTeleop();
    }
  }

  getManualKeysSummary(): string {
    const keys: string[] = [];
    if (this.state.manualKeys.w) keys.push("W");
    if (this.state.manualKeys.a) keys.push("A");
    if (this.state.manualKeys.s) keys.push("S");
    if (this.state.manualKeys.d) keys.push("D");
    if (this.state.manualBrakeHeld) keys.push("SPACE");
    return keys.length > 0 ? keys.join("+") : "-";
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private autoEnableManualModeFromTeleop(): void {
    if (this.state.manualMode || this.state.manualDisablePending || this.state.controlLocked) return;
    void this.setManualMode(true).catch((error) => {
      this.state = {
        ...this.state,
        lastStatus: `Manual mode auto-enable failed: ${String(error)}`
      };
      this.emit();
    });
  }

  private async setControlLock(locked: boolean, graceMs = 2000): Promise<void> {
    const response = await this.robotDispatcher.requestControlLock(locked);
    if (response.ok === false) {
      throw new Error(response.error ?? "Set control lock failed");
    }
    const now = Date.now();
    this.state = {
      ...this.state,
      controlLocked: locked,
      controlLockReason: locked ? "locked" : "unlocked",
      unlockGraceUntilMs: locked ? 0 : now + Math.max(0, graceMs),
      lastStatus: locked ? "Controls locked" : "Controls unlocked"
    };
    if (locked) {
      this.state = {
        ...this.state,
        manualMode: false,
        manualDisablePending: false
      };
      this.clearManualIntent();
      this.updateManualLoopLifecycle();
      this.stopControlHeartbeat();
    } else {
      this.startControlHeartbeat();
    }
    this.emit();
  }

  private applyControlLockPayload(message: Record<string, unknown>): void {
    const hasLocked = typeof message.control_locked === "boolean";
    const hasReason = typeof message.control_lock_reason === "string";
    if (!hasLocked && !hasReason) return;

    const nextLocked = hasLocked ? message.control_locked === true : this.state.controlLocked;
    const nextReason = hasReason ? String(message.control_lock_reason ?? "") : this.state.controlLockReason;
    this.state = {
      ...this.state,
      controlLocked: nextLocked,
      controlLockReason: nextReason,
      unlockGraceUntilMs: nextLocked ? 0 : this.state.unlockGraceUntilMs
    };
    if (nextLocked) {
      this.state = {
        ...this.state,
        manualMode: false,
        manualDisablePending: false
      };
      this.clearManualIntent();
      this.updateManualLoopLifecycle();
      this.stopControlHeartbeat();
    }
    this.emit();
  }

  private applyManualControlPayload(message: Record<string, unknown>): void {
    if (!message || typeof message !== "object") return;
    const manualRaw = message.manual_control;
    if (!manualRaw || typeof manualRaw !== "object") return;
    const manual = manualRaw as Record<string, unknown>;
    const enabledFromServer = manual.enabled === true;
    if (this.state.manualDisablePending && enabledFromServer) {
      return;
    }

    const nextLinear = Number(manual.linear_x_cmd ?? 0);
    const nextAngular = Number(manual.angular_z_cmd ?? 0);
    const safeLinear = Number.isFinite(nextLinear) ? nextLinear : 0;
    const safeAngular = Number.isFinite(nextAngular) ? nextAngular : 0;

    this.state = {
      ...this.state,
      manualMode: enabledFromServer,
      manualDisablePending: enabledFromServer ? this.state.manualDisablePending : false,
      manualCommand: {
        linearX: safeLinear,
        angularZ: safeAngular
      }
    };

    if (!enabledFromServer) {
      this.clearManualIntent();
    }
    this.updateManualLoopLifecycle();
    this.emit();
  }

  private clearManualIntent(): void {
    this.state = {
      ...this.state,
      manualKeys: {
        w: false,
        a: false,
        s: false,
        d: false
      },
      manualBrakeHeld: false,
      manualCommand: {
        linearX: 0,
        angularZ: 0
      }
    };
  }

  private updateManualLoopLifecycle(): void {
    const hasIntent =
      this.state.manualBrakeHeld ||
      this.state.manualKeys.w ||
      this.state.manualKeys.a ||
      this.state.manualKeys.s ||
      this.state.manualKeys.d;
    const shouldRun = this.state.manualMode || this.state.manualDisablePending || hasIntent;
    if (shouldRun) {
      if (!this.manualLoopTimer) {
        this.manualLoopTimer = setInterval(() => {
          void this.manualControlTick();
        }, this.manualLoopIntervalMs);
      }
      void this.manualControlTick();
      return;
    }
    if (this.manualLoopTimer) {
      clearInterval(this.manualLoopTimer);
      this.manualLoopTimer = null;
    }
  }

  private async manualControlTick(): Promise<void> {
    if (this.state.controlLocked || this.state.manualDisablePending) {
      this.state = {
        ...this.state,
        manualCommand: {
          linearX: 0,
          angularZ: 0
        }
      };
      this.emit();
      return;
    }

    const hasIntent =
      this.state.manualBrakeHeld ||
      this.state.manualKeys.w ||
      this.state.manualKeys.a ||
      this.state.manualKeys.s ||
      this.state.manualKeys.d;
    if (!this.state.manualMode && !hasIntent) {
      return;
    }

    let linear = 0;
    let angular = 0;
    let brake = false;

    if (this.state.manualBrakeHeld) {
      brake = true;
    } else {
      const forward = this.state.manualKeys.w ? 1 : 0;
      const reverse = this.state.manualKeys.s ? 1 : 0;
      const left = this.state.manualKeys.a ? 1 : 0;
      const right = this.state.manualKeys.d ? 1 : 0;
      linear = (forward - reverse) * this.state.manualLinearSpeed;
      angular = (left - right) * this.state.manualAngularSpeed;
      if (linear < 0) {
        angular = -angular;
      }
    }

    if (Math.abs(linear) < 1e-3) linear = 0;
    if (Math.abs(angular) < 1e-3) angular = 0;

    this.state = {
      ...this.state,
      manualCommand: {
        linearX: linear,
        angularZ: angular
      }
    };
    this.emit();

    if (!this.state.manualMode) return;
    try {
      await this.robotDispatcher.requestManualCommand(linear, angular, brake);
    } catch (error) {
      this.state = {
        ...this.state,
        lastStatus: `Manual command failed: ${String(error)}`
      };
      this.emit();
    }
  }
}

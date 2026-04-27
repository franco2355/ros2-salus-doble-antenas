import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";

export interface GoalInput {
  x: number;
  y: number;
  yawDeg: number;
}

export interface RouteMissionWaypoint extends GoalInput {}

export interface RouteMissionStateData {
  active: boolean;
  paused: boolean;
  loop: boolean;
  status: string;
  inputWaypointCount: number;
  expandedWaypointCount: number;
  currentStartIndex: number;
  currentTargetIndex: number;
  activeChunkSize: number;
  legSpacingM: number;
  chunkSpanM: number;
  chunkMaxWaypoints: number;
  missionWaypoints: RouteMissionWaypoint[];
  activeChunkWaypoints: RouteMissionWaypoint[];
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

export interface RecordingState {
  active: boolean;
  count: number;
  lastMessage: string;
}

export interface PatrolLoopState {
  active: boolean;
  currentWaypoint: number;
  totalWaypoints: number;
  label: string;
}

export interface NavigationState {
  waypoints: GoalInput[];
  selectedWaypointIndexes: number[];
  loopRoute: boolean;
  routeMission: RouteMissionStateData;
  goalMode: boolean;
  manualMode: boolean;
  manualDisablePending: boolean;
  manualLinearSpeed: number;
  manualAngularSpeed: number;
  manualLinearMin: number;
  manualLinearMax: number;
  manualAngularMin: number;
  manualAngularMax: number;
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
  recording: RecordingState;
  patrolLoop: PatrolLoopState;
  lastStatus: string;
  lastSnapshot: SnapshotData | null;
}

type NavigationListener = (state: NavigationState) => void;

const WAYPOINT_STORAGE_KEY = "cockpit.navigation.waypoints.v1";
const DEFAULT_MANUAL_LINEAR_MIN = 1.0;
const DEFAULT_MANUAL_LINEAR_MAX = 4.0;
const DEFAULT_MANUAL_LINEAR_SPEED = 1.2;
const DEFAULT_MANUAL_ANGULAR_MIN = 0.1;
const DEFAULT_MANUAL_ANGULAR_MAX = 1.2;
const DEFAULT_MANUAL_ANGULAR_SPEED = 0.4;
const MANUAL_LOOP_INTERVAL_MS = 50;
const navigationMemoryStorage = new Map<string, string>();

export interface NavigationManualDefaults {
  linearSpeed: number;
  angularSpeed: number;
  loopIntervalMs: number;
  linearMin: number;
  linearMax: number;
  angularMin: number;
  angularMax: number;
}

function clampInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeRange(
  rawMin: unknown,
  rawMax: unknown,
  fallbackMin: number,
  fallbackMax: number
): { min: number; max: number } {
  const minCandidate = Number(rawMin);
  const maxCandidate = Number(rawMax);
  const min = Number.isFinite(minCandidate) ? minCandidate : fallbackMin;
  const max = Number.isFinite(maxCandidate) ? maxCandidate : fallbackMax;
  if (max > min) return { min, max };
  return { min: fallbackMin, max: fallbackMax };
}

function clampManualLoopIntervalMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return MANUAL_LOOP_INTERVAL_MS;
  return Math.max(20, Math.round(parsed));
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractMessageText(message: Record<string, unknown>): string {
  const direct = typeof message.message === "string" ? message.message.trim() : "";
  if (direct) return direct;
  const payload = asRecord(message.payload);
  const nested = payload && typeof payload.message === "string" ? payload.message.trim() : "";
  return nested || "";
}

function messageCandidates(message: Record<string, unknown>): Record<string, unknown>[] {
  const direct = message;
  const payload = asRecord(message.payload);
  const directState = asRecord(message.state);
  const directTelemetry = asRecord(message.nav_telemetry);
  const payloadState = payload ? asRecord(payload.state) : null;
  const payloadTelemetry = payload ? asRecord(payload.nav_telemetry) : null;
  return [direct, payload, directState, directTelemetry, payloadState, payloadTelemetry].filter(
    (entry): entry is Record<string, unknown> => entry !== null
  );
}

function createDefaultRouteMission(): RouteMissionStateData {
  return {
    active: false,
    paused: false,
    loop: false,
    status: "idle",
    inputWaypointCount: 0,
    expandedWaypointCount: 0,
    currentStartIndex: 0,
    currentTargetIndex: 0,
    activeChunkSize: 0,
    legSpacingM: 0,
    chunkSpanM: 0,
    chunkMaxWaypoints: 0,
    missionWaypoints: [],
    activeChunkWaypoints: []
  };
}

function parseRouteWaypoint(input: unknown): RouteMissionWaypoint | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const lat = Number(value.lat ?? value.x);
  const lon = Number(value.lon ?? value.y);
  const yawDeg = Number(value.yaw_deg ?? value.yawDeg ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) {
    return null;
  }
  return {
    x: lat,
    y: lon,
    yawDeg
  };
}

function parseRouteMissionState(message: Record<string, unknown>): RouteMissionStateData | null {
  const candidate = messageCandidates(message)
    .map((entry) => asRecord(entry.route_mission))
    .find((entry): entry is Record<string, unknown> => entry !== null);
  if (!candidate) return null;

  const missionWaypoints = Array.isArray(candidate.mission_waypoints)
    ? candidate.mission_waypoints.map((entry) => parseRouteWaypoint(entry)).filter((entry): entry is RouteMissionWaypoint => entry !== null)
    : [];
  const activeChunkWaypoints = Array.isArray(candidate.active_chunk_waypoints)
    ? candidate.active_chunk_waypoints
        .map((entry) => parseRouteWaypoint(entry))
        .filter((entry): entry is RouteMissionWaypoint => entry !== null)
    : [];

  return {
    active: candidate.active === true,
    paused: candidate.paused === true,
    loop: candidate.loop === true,
    status: String(candidate.status ?? "idle"),
    inputWaypointCount: Number(candidate.input_waypoint_count ?? 0) || 0,
    expandedWaypointCount: Number(candidate.expanded_waypoint_count ?? 0) || 0,
    currentStartIndex: Number(candidate.current_start_index ?? 0) || 0,
    currentTargetIndex: Number(candidate.current_target_index ?? 0) || 0,
    activeChunkSize: Number(candidate.active_chunk_size ?? activeChunkWaypoints.length) || 0,
    legSpacingM: Number(candidate.leg_spacing_m ?? 0) || 0,
    chunkSpanM: Number(candidate.chunk_span_m ?? 0) || 0,
    chunkMaxWaypoints: Number(candidate.chunk_max_waypoints ?? 0) || 0,
    missionWaypoints,
    activeChunkWaypoints
  };
}

function isLegacyLockAliasMessage(message: Record<string, unknown>): boolean {
  if (String(message.op ?? "") !== "ack") return false;
  const request = String(message.request ?? "").trim();
  return request === "set_control_lock" || request === "control_heartbeat";
}

function extractControlLockData(message: Record<string, unknown>): { locked?: boolean; reason?: string } {
  const allowLegacyAlias = isLegacyLockAliasMessage(message);
  for (const candidate of messageCandidates(message)) {
    const lockedValue =
      typeof candidate.control_locked === "boolean"
        ? candidate.control_locked
        : allowLegacyAlias && typeof candidate.locked === "boolean"
          ? candidate.locked
          : undefined;
    const reasonValue =
      typeof candidate.control_lock_reason === "string"
        ? candidate.control_lock_reason
        : allowLegacyAlias && typeof candidate.lock_reason === "string"
          ? candidate.lock_reason
          : undefined;
    const hasLocked = typeof lockedValue === "boolean";
    const hasReason = typeof reasonValue === "string";
    if (!hasLocked && !hasReason) continue;
    return {
      locked: hasLocked ? lockedValue === true : undefined,
      reason: hasReason ? String(reasonValue ?? "") : undefined
    };
  }
  return {};
}

function extractControlLockFromNavEvent(message: Record<string, unknown>): { locked?: boolean; reason?: string } {
  const event = asRecord(message.event);
  if (!event) return {};
  const code = String(event.code ?? "").trim();
  if (!code) return {};
  const details = asRecord(event.details);
  const detailReason = details && details.reason != null ? String(details.reason ?? "").trim() : "";

  if (code === "CONTROL_LOCK_RELEASED") {
    return {
      locked: false,
      reason: detailReason
    };
  }
  if (code === "CONTROL_LOCK_ENGAGED") {
    return {
      locked: true,
      reason: detailReason || "UI_LOCK_REQUEST"
    };
  }
  if (code === "UI_HEARTBEAT_TIMEOUT") {
    return {
      locked: true,
      reason: detailReason || "UI_HEARTBEAT_TIMEOUT"
    };
  }
  return {};
}

function extractRecordingCount(message: Record<string, unknown>): number | null {
  for (const candidate of messageCandidates(message)) {
    if (!Object.prototype.hasOwnProperty.call(candidate, "recording_count")) continue;
    const count = Number(candidate.recording_count);
    if (Number.isFinite(count)) {
      return Math.max(0, Math.trunc(count));
    }
  }

  const isRecordingCountMessage = String(message.op ?? "").trim() === "recording_count";
  if (!isRecordingCountMessage) return null;
  const payload = asRecord(message.payload);
  const count = Number(message.count ?? payload?.count);
  if (!Number.isFinite(count)) return null;
  return Math.max(0, Math.trunc(count));
}

function parsePatrolLoopUpdate(raw: Record<string, unknown> | null): Partial<PatrolLoopState> | null {
  if (!raw) return null;
  const update: Partial<PatrolLoopState> = {};
  let hasValue = false;

  if (typeof raw.active === "boolean") {
    update.active = raw.active === true;
    hasValue = true;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "current_wp") || Object.prototype.hasOwnProperty.call(raw, "currentWaypoint")) {
    const currentWaypoint = Number(raw.current_wp ?? raw.currentWaypoint);
    if (Number.isFinite(currentWaypoint)) {
      update.currentWaypoint = Math.trunc(currentWaypoint);
      hasValue = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "total_wp") || Object.prototype.hasOwnProperty.call(raw, "totalWaypoints")) {
    const totalWaypoints = Number(raw.total_wp ?? raw.totalWaypoints);
    if (Number.isFinite(totalWaypoints)) {
      update.totalWaypoints = Math.max(0, Math.trunc(totalWaypoints));
      hasValue = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "label")) {
    update.label = String(raw.label ?? "");
    hasValue = true;
  }

  return hasValue ? update : null;
}

function extractPatrolLoopUpdate(message: Record<string, unknown>): Partial<PatrolLoopState> | null {
  const directPatrolStatus = parsePatrolLoopUpdate(asRecord(message.patrol_status));
  if (directPatrolStatus) return directPatrolStatus;

  for (const candidate of messageCandidates(message)) {
    const nested = parsePatrolLoopUpdate(asRecord(candidate.patrol_status));
    if (nested) return nested;
  }

  if (String(message.op ?? "").trim() !== "patrol_status") return null;
  return parsePatrolLoopUpdate(message) ?? parsePatrolLoopUpdate(asRecord(message.payload));
}

export class NavigationService {
  private readonly listeners = new Set<NavigationListener>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private manualLoopTimer: ReturnType<typeof setInterval> | null = null;
  private manualLoopIntervalMs: number;
  private manualLinearMin = DEFAULT_MANUAL_LINEAR_MIN;
  private manualLinearMax = DEFAULT_MANUAL_LINEAR_MAX;
  private manualAngularMin = DEFAULT_MANUAL_ANGULAR_MIN;
  private manualAngularMax = DEFAULT_MANUAL_ANGULAR_MAX;
  private state: NavigationState = {
    waypoints: [],
    selectedWaypointIndexes: [],
    loopRoute: true,
    routeMission: createDefaultRouteMission(),
    goalMode: false,
    manualMode: false,
    manualDisablePending: false,
    manualLinearSpeed: DEFAULT_MANUAL_LINEAR_SPEED,
    manualAngularSpeed: DEFAULT_MANUAL_ANGULAR_SPEED,
    manualLinearMin: DEFAULT_MANUAL_LINEAR_MIN,
    manualLinearMax: DEFAULT_MANUAL_LINEAR_MAX,
    manualAngularMin: DEFAULT_MANUAL_ANGULAR_MIN,
    manualAngularMax: DEFAULT_MANUAL_ANGULAR_MAX,
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
    recording: {
      active: false,
      count: 0,
      lastMessage: ""
    },
    patrolLoop: {
      active: false,
      currentWaypoint: -1,
      totalWaypoints: 0,
      label: ""
    },
    lastStatus: "No active goal",
    lastSnapshot: null
  };

  constructor(private readonly robotDispatcher: RobotDispatcher, manualDefaults?: Partial<NavigationManualDefaults>) {
    const linearRange = normalizeRange(
      manualDefaults?.linearMin,
      manualDefaults?.linearMax,
      DEFAULT_MANUAL_LINEAR_MIN,
      DEFAULT_MANUAL_LINEAR_MAX
    );
    const angularRange = normalizeRange(
      manualDefaults?.angularMin,
      manualDefaults?.angularMax,
      DEFAULT_MANUAL_ANGULAR_MIN,
      DEFAULT_MANUAL_ANGULAR_MAX
    );
    this.manualLinearMin = linearRange.min;
    this.manualLinearMax = linearRange.max;
    this.manualAngularMin = angularRange.min;
    this.manualAngularMax = angularRange.max;
    const safeLinearSpeed = clampInRange(
      manualDefaults?.linearSpeed,
      DEFAULT_MANUAL_LINEAR_SPEED,
      this.manualLinearMin,
      this.manualLinearMax
    );
    const safeAngularSpeed = clampInRange(
      manualDefaults?.angularSpeed,
      DEFAULT_MANUAL_ANGULAR_SPEED,
      this.manualAngularMin,
      this.manualAngularMax
    );
    this.manualLoopIntervalMs = clampManualLoopIntervalMs(manualDefaults?.loopIntervalMs);

    this.state = {
      ...this.state,
      manualLinearSpeed: safeLinearSpeed,
      manualAngularSpeed: safeAngularSpeed,
      manualLinearMin: this.manualLinearMin,
      manualLinearMax: this.manualLinearMax,
      manualAngularMin: this.manualAngularMin,
      manualAngularMax: this.manualAngularMax
    };

    this.startControlHeartbeat();

    const dispatcher = this.robotDispatcher as unknown as {
      subscribeState?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribeNavTelemetry?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribeAck?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribeNavEvent?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribeRecordingCount?: (callback: (message: Record<string, unknown>) => void) => () => void;
      subscribePatrolStatus?: (callback: (message: Record<string, unknown>) => void) => () => void;
    };
    dispatcher.subscribeState?.((message) => {
      this.applyControlLockPayload(message);
      this.applyManualControlPayload(message);
      this.applyRecordingCountPayload(message);
      this.applyPatrolLoopPayload(message);
      this.applyRouteMissionPayload(message);
    });
    dispatcher.subscribeNavTelemetry?.((message) => {
      this.applyControlLockPayload(message);
      this.applyManualControlPayload(message);
      this.applyRouteMissionPayload(message);
    });
    dispatcher.subscribeAck?.((message) => {
      const request = String(message.request ?? "").trim();
      const isSetControlLockAck = String(message.op ?? "") === "ack" && request === "set_control_lock";
      this.applyControlLockPayload(message, {
        overrideGrace: isSetControlLockAck,
        startUnlockGrace: isSetControlLockAck
      });
      this.applyManualControlPayload(message);
      this.applyRouteMissionPayload(message);
    });
    dispatcher.subscribeNavEvent?.((message) => {
      const fromEvent = extractControlLockFromNavEvent(message);
      this.applyControlLockUpdate(fromEvent);
    });
    dispatcher.subscribeRecordingCount?.((message) => {
      this.applyRecordingCountPayload(message);
    });
    dispatcher.subscribePatrolStatus?.((message) => {
      this.applyPatrolLoopPayload(message);
    });
  }

  getState(): NavigationState {
    return {
      ...this.state,
      waypoints: this.state.waypoints.map((waypoint) => ({ ...waypoint })),
      routeMission: {
        ...this.state.routeMission,
        missionWaypoints: this.state.routeMission.missionWaypoints.map((waypoint) => ({ ...waypoint })),
        activeChunkWaypoints: this.state.routeMission.activeChunkWaypoints.map((waypoint) => ({ ...waypoint }))
      },
      selectedWaypointIndexes: [...this.state.selectedWaypointIndexes],
      manualCommand: { ...this.state.manualCommand },
      manualKeys: { ...this.state.manualKeys },
      recording: { ...this.state.recording },
      patrolLoop: { ...this.state.patrolLoop },
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

  async startRecording(): Promise<void> {
    const response = await this.robotDispatcher.requestStartRecording();
    if (response.ok === false) {
      throw new Error(response.error ?? "Start recording failed");
    }
    this.state = {
      ...this.state,
      recording: {
        ...this.state.recording,
        active: true,
        lastMessage: ""
      },
      lastStatus: "Waypoint recording started"
    };
    this.emit();
  }

  async stopRecording(): Promise<void> {
    const response = await this.robotDispatcher.requestStopRecording();
    if (response.ok === false) {
      throw new Error(response.error ?? "Stop recording failed");
    }
    const message = extractMessageText(response as Record<string, unknown>) || "saved";
    this.state = {
      ...this.state,
      recording: {
        ...this.state.recording,
        active: false,
        lastMessage: message
      },
      lastStatus: "Waypoint recording stopped"
    };
    this.emit();
  }

  async clearRecording(): Promise<void> {
    const response = await this.robotDispatcher.requestClearRecording();
    if (response.ok === false) {
      throw new Error(response.error ?? "Clear recording failed");
    }
    const message = extractMessageText(response as Record<string, unknown>) || "recording cleared";
    this.state = {
      ...this.state,
      recording: {
        active: false,
        count: 0,
        lastMessage: message
      },
      lastStatus: "Waypoint recording cleared"
    };
    this.emit();
  }

  async startPatrol(): Promise<void> {
    const response = await this.robotDispatcher.requestStartPatrol();
    if (response.ok === false) {
      throw new Error(response.error ?? "Start patrol failed");
    }
    this.state = {
      ...this.state,
      patrolLoop: {
        ...this.state.patrolLoop,
        active: true
      },
      lastStatus: "Loop patrol started"
    };
    this.emit();
  }

  async stopPatrol(): Promise<void> {
    const response = await this.robotDispatcher.requestStopPatrol();
    if (response.ok === false) {
      throw new Error(response.error ?? "Stop patrol failed");
    }
    this.state = {
      ...this.state,
      patrolLoop: {
        ...this.state.patrolLoop,
        active: false
      },
      lastStatus: "Loop patrol stopped"
    };
    this.emit();
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

  async sendRouteMission(options?: {
    legSpacingM?: number;
    chunkSpanM?: number;
    chunkMaxWaypoints?: number;
  }): Promise<{ inputCount: number; expandedCount: number; loopRoute: boolean }> {
    if (this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
    if (this.state.manualMode) {
      this.state = {
        ...this.state,
        manualDisablePending: true,
        lastStatus: "Disabling manual mode to start route..."
      };
      this.emit();
      await this.setManualMode(false);
    }

    const queued = this.state.waypoints.map((entry) => parseGoal(entry));
    if (queued.length === 0) {
      throw new Error("No waypoint queued");
    }

    const payload: Record<string, unknown> = {
      waypoints: queued.map((entry) => ({
        lat: entry.x,
        lon: entry.y,
        yaw_deg: entry.yawDeg
      })),
      loop: this.state.loopRoute
    };
    if (options?.legSpacingM !== undefined) payload.leg_spacing_m = Number(options.legSpacingM);
    if (options?.chunkSpanM !== undefined) payload.chunk_span_m = Number(options.chunkSpanM);
    if (options?.chunkMaxWaypoints !== undefined) payload.chunk_max_waypoints = Number(options.chunkMaxWaypoints);

    const response = await this.robotDispatcher.requestRouteMission(payload as never);
    if (response.ok === false) {
      throw new Error(String(response.error ?? "Route mission dispatch failed"));
    }

    const inputCount = Number(response.input_waypoint_count ?? queued.length) || queued.length;
    const expandedCount = Number(response.expanded_waypoint_count ?? queued.length) || queued.length;
    this.state = {
      ...this.state,
      lastStatus: `Route mission sent (${inputCount} -> ${expandedCount})`
    };
    this.emit();
    return {
      inputCount,
      expandedCount,
      loopRoute: this.state.loopRoute
    };
  }

  async sendGoal(input: GoalInput): Promise<void> {
    if (this.state.controlLocked) {
      throw new Error(`Controls are locked (${this.state.controlLockReason || "locked"})`);
    }
    const validated = parseGoal(input);
    const payload = {
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

  async cancelRouteMission(): Promise<void> {
    const response = await this.robotDispatcher.requestCancelRouteMission();
    if (response.ok === false) {
      throw new Error(response.error ?? "Cancel route failed");
    }
    this.state = {
      ...this.state,
      lastStatus: "Route mission cancelled",
      routeMission: {
        ...this.state.routeMission,
        active: false,
        paused: false,
        status: "route cancelled",
        activeChunkSize: 0,
        activeChunkWaypoints: []
      }
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
    const clamped = clampInRange(value, this.state.manualLinearSpeed, this.manualLinearMin, this.manualLinearMax);
    this.state = {
      ...this.state,
      manualLinearSpeed: clamped
    };
    this.emit();
  }

  setManualAngularSpeed(value: number): void {
    const clamped = clampInRange(value, this.state.manualAngularSpeed, this.manualAngularMin, this.manualAngularMax);
    this.state = {
      ...this.state,
      manualAngularSpeed: clamped
    };
    this.emit();
  }

  applyRuntimeDefaults(defaults: Partial<NavigationManualDefaults>): void {
    const nextLinearRange = normalizeRange(
      defaults.linearMin ?? this.manualLinearMin,
      defaults.linearMax ?? this.manualLinearMax,
      DEFAULT_MANUAL_LINEAR_MIN,
      DEFAULT_MANUAL_LINEAR_MAX
    );
    const nextAngularRange = normalizeRange(
      defaults.angularMin ?? this.manualAngularMin,
      defaults.angularMax ?? this.manualAngularMax,
      DEFAULT_MANUAL_ANGULAR_MIN,
      DEFAULT_MANUAL_ANGULAR_MAX
    );
    const nextLinear =
      defaults.linearSpeed !== undefined
        ? clampInRange(defaults.linearSpeed, this.state.manualLinearSpeed, nextLinearRange.min, nextLinearRange.max)
        : clampInRange(this.state.manualLinearSpeed, DEFAULT_MANUAL_LINEAR_SPEED, nextLinearRange.min, nextLinearRange.max);
    const nextAngular =
      defaults.angularSpeed !== undefined
        ? clampInRange(defaults.angularSpeed, this.state.manualAngularSpeed, nextAngularRange.min, nextAngularRange.max)
        : clampInRange(this.state.manualAngularSpeed, DEFAULT_MANUAL_ANGULAR_SPEED, nextAngularRange.min, nextAngularRange.max);
    const nextLoopInterval =
      defaults.loopIntervalMs !== undefined ? clampManualLoopIntervalMs(defaults.loopIntervalMs) : this.manualLoopIntervalMs;

    const rangesChanged =
      nextLinearRange.min !== this.manualLinearMin ||
      nextLinearRange.max !== this.manualLinearMax ||
      nextAngularRange.min !== this.manualAngularMin ||
      nextAngularRange.max !== this.manualAngularMax;
    const speedChanged = nextLinear !== this.state.manualLinearSpeed || nextAngular !== this.state.manualAngularSpeed;
    const intervalChanged = nextLoopInterval !== this.manualLoopIntervalMs;
    if (!speedChanged && !intervalChanged && !rangesChanged) return;

    this.manualLoopIntervalMs = nextLoopInterval;
    this.manualLinearMin = nextLinearRange.min;
    this.manualLinearMax = nextLinearRange.max;
    this.manualAngularMin = nextAngularRange.min;
    this.manualAngularMax = nextAngularRange.max;
    this.state = {
      ...this.state,
      manualLinearSpeed: nextLinear,
      manualAngularSpeed: nextAngular,
      manualLinearMin: this.manualLinearMin,
      manualLinearMax: this.manualLinearMax,
      manualAngularMin: this.manualAngularMin,
      manualAngularMax: this.manualAngularMax
    };
    if (intervalChanged && this.manualLoopTimer) {
      clearInterval(this.manualLoopTimer);
      this.manualLoopTimer = null;
      this.updateManualLoopLifecycle();
    }
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
    }
    this.emit();
  }

  private applyControlLockPayload(
    message: Record<string, unknown>,
    options?: { overrideGrace?: boolean; startUnlockGrace?: boolean; graceMs?: number }
  ): void {
    const controlLock = extractControlLockData(message);
    this.applyControlLockUpdate(controlLock, options);
  }

  private applyControlLockUpdate(
    controlLock: { locked?: boolean; reason?: string },
    options?: { overrideGrace?: boolean; startUnlockGrace?: boolean; graceMs?: number }
  ): void {
    const hasLocked = typeof controlLock.locked === "boolean";
    const hasReason = typeof controlLock.reason === "string";
    if (!hasLocked && !hasReason) return;

    const prevLocked = this.state.controlLocked;
    const nextLocked = hasLocked ? controlLock.locked === true : this.state.controlLocked;
    const nextReason = hasReason ? String(controlLock.reason ?? "") : this.state.controlLockReason;
    const nowMs = Date.now();
    const unlockGraceUntilMs = Number(this.state.unlockGraceUntilMs || 0);
    const ignoreStaleRelock =
      !prevLocked &&
      nextLocked &&
      nowMs < unlockGraceUntilMs &&
      options?.overrideGrace !== true;
    if (ignoreStaleRelock) {
      return;
    }

    let nextUnlockGraceUntilMs = unlockGraceUntilMs;
    if (nextLocked) {
      nextUnlockGraceUntilMs = 0;
    } else if (options?.startUnlockGrace === true) {
      const graceMs = Math.max(0, Math.round(Number(options.graceMs ?? 2000)));
      nextUnlockGraceUntilMs = nowMs + graceMs;
    } else if (unlockGraceUntilMs <= nowMs) {
      nextUnlockGraceUntilMs = 0;
    }

    const changed =
      nextLocked !== this.state.controlLocked ||
      nextReason !== this.state.controlLockReason ||
      nextUnlockGraceUntilMs !== this.state.unlockGraceUntilMs;
    if (!changed) return;

    this.state = {
      ...this.state,
      controlLocked: nextLocked,
      controlLockReason: nextReason,
      unlockGraceUntilMs: nextUnlockGraceUntilMs
    };
    if (nextLocked) {
      this.state = {
        ...this.state,
        manualMode: false,
        manualDisablePending: false
      };
      this.clearManualIntent();
      this.updateManualLoopLifecycle();
    }
    this.emit();
  }

  private applyManualControlPayload(message: Record<string, unknown>): void {
    if (!message || typeof message !== "object") return;
    const manual = messageCandidates(message)
      .map((candidate) => asRecord(candidate.manual_control))
      .find((value): value is Record<string, unknown> => value !== null);
    if (!manual) return;
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

  private applyRecordingCountPayload(message: Record<string, unknown>): void {
    const count = extractRecordingCount(message);
    if (count === null || count === this.state.recording.count) return;
    this.state = {
      ...this.state,
      recording: {
        ...this.state.recording,
        count
      }
    };
    this.emit();
  }

  private applyPatrolLoopPayload(message: Record<string, unknown>): void {
    const update = extractPatrolLoopUpdate(message);
    if (!update) return;
    const next = {
      ...this.state.patrolLoop,
      ...update
    };
    const changed =
      next.active !== this.state.patrolLoop.active ||
      next.currentWaypoint !== this.state.patrolLoop.currentWaypoint ||
      next.totalWaypoints !== this.state.patrolLoop.totalWaypoints ||
      next.label !== this.state.patrolLoop.label;
    if (!changed) return;
    this.state = {
      ...this.state,
      patrolLoop: next
    };
    this.emit();
  }

  private applyRouteMissionPayload(message: Record<string, unknown>): void {
    const routeMission = parseRouteMissionState(message);
    if (!routeMission) return;
    const routeStatus = routeMission.status.trim();
    this.state = {
      ...this.state,
      routeMission,
      lastStatus: routeStatus.length > 0 ? routeStatus : this.state.lastStatus
    };
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

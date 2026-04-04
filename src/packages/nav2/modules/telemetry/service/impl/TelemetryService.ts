import type { RobotStatus } from "../../../navigation/dispatcher/impl/RobotDispatcher";
import type { RobotDispatcher } from "../../../navigation/dispatcher/impl/RobotDispatcher";
import type { EventBus } from "../../../../../../core/events/eventBus";

export interface TelemetryEvent {
  level: string;
  code?: string;
  text: string;
  timestamp: number;
}

export interface TelemetrySnapshot {
  robotStatus: RobotStatus;
  robotPose: {
    lat: number;
    lon: number;
    headingDeg: number;
  } | null;
  cmdVelSafe: string;
  goalActive: boolean;
  navResultStatus: number;
  navResultText: string;
  navResultEventId: number;
  controlLocked: boolean;
  controlLockReason: string;
  recentEvents: TelemetryEvent[];
  alerts: TelemetryEvent[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function isLegacyLockAliasMessage(message: Record<string, unknown>): boolean {
  if (String(message.op ?? "") !== "ack") return false;
  const request = String(message.request ?? "").trim();
  return request === "set_control_lock" || request === "control_heartbeat";
}

function resolveNavTelemetryPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const allowLegacyAlias = isLegacyLockAliasMessage(raw);
  const hasTelemetryField = (candidate: Record<string, unknown>): boolean =>
    candidate.mode !== undefined ||
    candidate.battery_pct !== undefined ||
    candidate.batteryPct !== undefined ||
    candidate.cmd_vel_safe !== undefined ||
    candidate.goal_active !== undefined ||
    candidate.control_locked !== undefined ||
    (allowLegacyAlias && candidate.locked !== undefined) ||
    candidate.control_lock_reason !== undefined ||
    (allowLegacyAlias && candidate.lock_reason !== undefined) ||
    candidate.connected !== undefined;

  for (const candidate of messageCandidates(raw)) {
    if (hasTelemetryField(candidate)) return candidate;
  }
  return raw;
}

function resolvePosePayload(raw: Record<string, unknown>): Record<string, unknown> | null {
  for (const candidate of messageCandidates(raw)) {
    const robotPose = asRecord(candidate.robot_pose);
    if (robotPose) return robotPose;
    const pose = asRecord(candidate.pose);
    if (pose) return pose;
  }
  return null;
}

export class TelemetryService {
  private readonly listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private snapshot: TelemetrySnapshot = {
    robotStatus: {
      batteryPct: 0,
      mode: "disconnected",
      connected: false
    },
    robotPose: null,
    cmdVelSafe: "n/a",
    goalActive: false,
    navResultStatus: 0,
    navResultText: "idle",
    navResultEventId: 0,
    controlLocked: false,
    controlLockReason: "",
    recentEvents: [],
    alerts: []
  };

  constructor(private readonly robotDispatcher: RobotDispatcher, eventBus: EventBus) {
    this.robotDispatcher.subscribeRobotStatus((status) => {
      this.snapshot = {
        ...this.snapshot,
        robotStatus: status
      };
      this.emit();
    });

    this.robotDispatcher.subscribeState((message) => {
      this.applyNavTelemetryPayload(message);
      this.applyPosePayload(resolvePosePayload(message));
      if (Array.isArray(message.alerts)) {
        this.setAlerts(
          message.alerts
            .map((entry) => this.normalizeTelemetryEvent(entry))
            .filter((entry): entry is TelemetryEvent => entry !== null)
        );
      }
      if (Array.isArray(message.recent_events)) {
        this.setRecentEvents(
          message.recent_events
            .map((entry) => this.normalizeTelemetryEvent(entry))
            .filter((entry): entry is TelemetryEvent => entry !== null)
        );
      }
      this.emit();
    });

    this.robotDispatcher.subscribeNavTelemetry((message) => {
      this.applyNavTelemetryPayload(message);
      this.emit();
    });

    this.robotDispatcher.subscribeNavEvent((message) => {
      const event = this.normalizeTelemetryEvent(message.event);
      if (!event) return;
      this.pushEvent(event);
    });

    this.robotDispatcher.subscribeNavAlerts((message) => {
      if (!Array.isArray(message.alerts)) return;
      this.setAlerts(
        message.alerts
          .map((entry) => this.normalizeTelemetryEvent(entry))
          .filter((entry): entry is TelemetryEvent => entry !== null)
      );
      this.emit();
    });

    this.robotDispatcher.subscribeRobotPose((message) => {
      this.applyPosePayload(resolvePosePayload(message));
      this.emit();
    });

    this.robotDispatcher.subscribeAck((message) => {
      this.applyNavTelemetryPayload(message);
      this.emit();
    });

    eventBus.on<{ level: string; text: string; timestamp: number }>("console.event", (event) => {
      this.pushEvent({
        level: event.level,
        text: event.text,
        timestamp: event.timestamp
      });
    });
  }

  subscribeRobotStatus(callback: (status: RobotStatus) => void): () => void {
    return this.robotDispatcher.subscribeRobotStatus(callback);
  }

  getSnapshot(): TelemetrySnapshot {
    return {
      robotStatus: { ...this.snapshot.robotStatus },
      robotPose: this.snapshot.robotPose ? { ...this.snapshot.robotPose } : null,
      cmdVelSafe: this.snapshot.cmdVelSafe,
      goalActive: this.snapshot.goalActive,
      navResultStatus: this.snapshot.navResultStatus,
      navResultText: this.snapshot.navResultText,
      navResultEventId: this.snapshot.navResultEventId,
      controlLocked: this.snapshot.controlLocked,
      controlLockReason: this.snapshot.controlLockReason,
      recentEvents: [...this.snapshot.recentEvents],
      alerts: [...this.snapshot.alerts]
    };
  }

  subscribeTelemetry(callback: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(callback);
    callback(this.getSnapshot());
    return () => {
      this.listeners.delete(callback);
    };
  }

  pushEvent(event: TelemetryEvent): void {
    const nextRecent = [event, ...this.snapshot.recentEvents].slice(0, 40);
    const nextAlerts =
      event.level === "error" || event.level === "warn" ? this.mergeAlerts([event], this.snapshot.alerts) : this.snapshot.alerts;

    this.snapshot = {
      ...this.snapshot,
      recentEvents: nextRecent,
      alerts: nextAlerts
    };
    this.emit();
  }

  private setAlerts(alerts: TelemetryEvent[]): void {
    this.snapshot = {
      ...this.snapshot,
      alerts: this.mergeAlerts(alerts, this.snapshot.alerts)
    };
  }

  private setRecentEvents(events: TelemetryEvent[]): void {
    this.snapshot = {
      ...this.snapshot,
      recentEvents: events.slice(0, 80)
    };
  }

  private normalizeTelemetryEvent(raw: unknown): TelemetryEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const text = String(value.text ?? value.message ?? value.msg ?? "");
    if (!text) return null;
    return {
      level: String(value.level ?? value.severity ?? "info").toLowerCase(),
      code: value.code != null ? String(value.code) : undefined,
      text,
      timestamp: Number(value.timestamp ?? value.stamp_ms ?? Date.now())
    };
  }

  private applyPosePayload(raw: Record<string, unknown> | null): void {
    if (!raw) return;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.snapshot = {
      ...this.snapshot,
      robotPose: {
        lat,
        lon,
        headingDeg: Number(raw.heading_deg ?? raw.headingDeg ?? 0)
      }
    };
  }

  private applyNavTelemetryPayload(raw: Record<string, unknown>): void {
    const payload = resolveNavTelemetryPayload(raw);
    const allowLegacyAlias = isLegacyLockAliasMessage(raw);
    const mode = String(payload.mode ?? this.snapshot.robotStatus.mode);
    const battery = Number(payload.battery_pct ?? payload.batteryPct ?? this.snapshot.robotStatus.batteryPct);
    const connected = payload.connected === true || this.snapshot.robotStatus.connected;
    this.snapshot = {
      ...this.snapshot,
      robotStatus: {
        mode,
        batteryPct: Number.isFinite(battery) ? battery : this.snapshot.robotStatus.batteryPct,
        connected
      },
      cmdVelSafe: String(payload.cmd_vel_safe ?? this.snapshot.cmdVelSafe),
      goalActive: payload.goal_active === true ? true : payload.goal_active === false ? false : this.snapshot.goalActive,
      navResultStatus: Number.isFinite(Number(payload.nav_result_status))
        ? Number(payload.nav_result_status)
        : this.snapshot.navResultStatus,
      navResultText: String(payload.nav_result_text ?? this.snapshot.navResultText),
      navResultEventId: Number.isFinite(Number(payload.nav_result_event_id))
        ? Number(payload.nav_result_event_id)
        : this.snapshot.navResultEventId,
      controlLocked:
        payload.control_locked === true
          ? true
          : payload.control_locked === false
            ? false
            : allowLegacyAlias && payload.locked === true
              ? true
              : allowLegacyAlias && payload.locked === false
                ? false
                : this.snapshot.controlLocked,
      controlLockReason: String(
        payload.control_lock_reason ?? (allowLegacyAlias ? payload.lock_reason : undefined) ?? this.snapshot.controlLockReason
      )
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private mergeAlerts(incoming: TelemetryEvent[], existing: TelemetryEvent[]): TelemetryEvent[] {
    const keyed = new Map<string, TelemetryEvent>();
    [...incoming, ...existing].forEach((entry) => {
      const level = String(entry.level ?? "info").toLowerCase();
      const code = entry.code ? String(entry.code) : "";
      const text = String(entry.text ?? "");
      const timestamp = Number(entry.timestamp ?? 0);
      const key = `${timestamp}|${level}|${code}|${text}`;
      if (!keyed.has(key)) {
        keyed.set(key, {
          level,
          code: code || undefined,
          text,
          timestamp
        });
      }
    });
    return [...keyed.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 80);
  }
}

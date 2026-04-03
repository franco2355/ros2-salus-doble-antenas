import type { RobotStatus } from "../../dispatcher/impl/RobotDispatcher";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import type { EventBus } from "../../core/events/eventBus";

export interface TelemetryEvent {
  level: string;
  text: string;
  timestamp: number;
}

export interface TelemetrySnapshot {
  robotStatus: RobotStatus;
  recentEvents: TelemetryEvent[];
  alerts: TelemetryEvent[];
}

export class TelemetryService {
  private readonly listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private snapshot: TelemetrySnapshot = {
    robotStatus: {
      batteryPct: 0,
      mode: "disconnected",
      connected: false
    },
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
      event.level === "error" || event.level === "warn"
        ? [event, ...this.snapshot.alerts].slice(0, 20)
        : this.snapshot.alerts;

    this.snapshot = {
      ...this.snapshot,
      recentEvents: nextRecent,
      alerts: nextAlerts
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

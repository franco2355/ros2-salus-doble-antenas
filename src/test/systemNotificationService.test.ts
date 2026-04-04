import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../core/events/eventBus";
import { CORE_EVENTS } from "../core/events/topics";
import type { CoreNotificationSettings } from "../core/types/settings";
import {
  DEFAULT_CORE_NOTIFICATION_SETTINGS,
  resetCoreNotificationSettings,
  saveCoreNotificationSettings
} from "../core/config/globalNotificationConfig";
import { SystemNotificationService } from "../packages/core/services/impl/SystemNotificationService";

interface ConnectionState {
  connected: boolean;
  lastError: string;
  txBytes: number;
  rxBytes: number;
}

interface TelemetryEvent {
  code?: string;
  text: string;
  timestamp: number;
}

interface TelemetrySnapshot {
  goalActive: boolean;
  navResultStatus: number;
  navResultText: string;
  navResultEventId: number;
  recentEvents: TelemetryEvent[];
  alerts: TelemetryEvent[];
}

class FakeConnectionService {
  private listeners = new Set<(state: ConnectionState) => void>();
  constructor(private state: ConnectionState) {}
  getState(): ConnectionState {
    return { ...this.state };
  }
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }
  setState(next: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...next };
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

class FakeTelemetryService {
  private listeners = new Set<(state: TelemetrySnapshot) => void>();
  constructor(private state: TelemetrySnapshot) {}
  getSnapshot(): TelemetrySnapshot {
    return {
      ...this.state,
      recentEvents: [...this.state.recentEvents],
      alerts: [...this.state.alerts]
    };
  }
  subscribeTelemetry(listener: (state: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }
  setSnapshot(next: Partial<TelemetrySnapshot>): void {
    this.state = {
      ...this.state,
      ...next
    };
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function createRuntime(connection: FakeConnectionService, telemetry: FakeTelemetryService) {
  return {
    eventBus: createEventBus(),
    getService<T>(serviceId: string): T {
      if (serviceId === "service.connection") return connection as T;
      if (serviceId === "service.telemetry") return telemetry as T;
      throw new Error(`Service not found: ${serviceId}`);
    }
  };
}

describe("SystemNotificationService", () => {
  beforeEach(async () => {
    await resetCoreNotificationSettings();
    vi.useRealTimers();
  });

  it("notifies route completion only when window is unfocused", async () => {
    const connection = new FakeConnectionService({
      connected: true,
      lastError: "",
      txBytes: 0,
      rxBytes: 0
    });
    const telemetry = new FakeTelemetryService({
      goalActive: true,
      navResultStatus: 2,
      navResultText: "",
      navResultEventId: 1,
      recentEvents: [],
      alerts: []
    });
    const runtime = createRuntime(connection, telemetry);
    const notifyFn = vi.fn<(title: string, body: string) => Promise<void>>().mockResolvedValue();
    const service = new SystemNotificationService();
    const settings: CoreNotificationSettings = {
      ...DEFAULT_CORE_NOTIFICATION_SETTINGS,
      connected_reminder_enabled: false
    };

    const stop = service.start({
      runtime,
      notifyFn,
      isFocusedFn: async () => false
    });
    runtime.eventBus.emit(CORE_EVENTS.globalNotificationSettingsUpdated, { settings });
    (service as unknown as { pageHidden: boolean }).pageHidden = true;

    telemetry.setSnapshot({
      goalActive: false,
      navResultStatus: 4,
      navResultEventId: 2
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyFn).toHaveBeenCalledWith("Recorrido completado", "El robot completó el recorrido.");

    stop();
  });

  it("applies cooldown for obstacle notifications", async () => {
    const connection = new FakeConnectionService({
      connected: true,
      lastError: "",
      txBytes: 0,
      rxBytes: 0
    });
    const telemetry = new FakeTelemetryService({
      goalActive: false,
      navResultStatus: 0,
      navResultText: "",
      navResultEventId: 0,
      recentEvents: [],
      alerts: []
    });
    let now = 1_000_000;
    const runtime = createRuntime(connection, telemetry);
    const notifyFn = vi.fn<(title: string, body: string) => Promise<void>>().mockResolvedValue();
    const service = new SystemNotificationService();
    const settings: CoreNotificationSettings = {
      ...DEFAULT_CORE_NOTIFICATION_SETTINGS,
      notification_cooldown_ms: 30_000
    };
    const stop = service.start({
      runtime,
      notifyFn,
      isFocusedFn: async () => false,
      getNow: () => now
    });
    runtime.eventBus.emit(CORE_EVENTS.globalNotificationSettingsUpdated, { settings });
    (service as unknown as { pageHidden: boolean }).pageHidden = true;

    telemetry.setSnapshot({
      recentEvents: [{ code: "PATH_BLOCKED", text: "path blocked by obstacle", timestamp: 10 }]
    });
    await vi.waitFor(() => expect(notifyFn).toHaveBeenCalledTimes(1));
    telemetry.setSnapshot({
      recentEvents: [{ code: "PATH_BLOCKED", text: "path blocked by obstacle again", timestamp: 11 }]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyFn).toHaveBeenCalledTimes(1);

    now += 31_000;
    telemetry.setSnapshot({
      recentEvents: [{ code: "PATH_BLOCKED", text: "path blocked by obstacle third", timestamp: 12 }]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyFn).toHaveBeenCalledTimes(2);

    stop();
  });

  it("sends connected reminders with total bytes", async () => {
    vi.useFakeTimers();
    const connection = new FakeConnectionService({
      connected: true,
      lastError: "",
      txBytes: 1024,
      rxBytes: 2048
    });
    const telemetry = new FakeTelemetryService({
      goalActive: false,
      navResultStatus: 0,
      navResultText: "",
      navResultEventId: 0,
      recentEvents: [],
      alerts: []
    });
    const runtime = createRuntime(connection, telemetry);
    const notifyFn = vi.fn<(title: string, body: string) => Promise<void>>().mockResolvedValue();
    const service = new SystemNotificationService();
    const settings: CoreNotificationSettings = {
      ...DEFAULT_CORE_NOTIFICATION_SETTINGS,
      connected_reminder_enabled: true,
      connected_reminder_interval_ms: 60_000,
      notification_cooldown_ms: 5_000,
      notify_on_connection_lost: false
    };
    await saveCoreNotificationSettings(settings);
    const stop = service.start({
      runtime,
      notifyFn,
      isFocusedFn: async () => false
    });
    runtime.eventBus.emit(CORE_EVENTS.globalNotificationSettingsUpdated, { settings });
    (service as unknown as { pageHidden: boolean }).pageHidden = true;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn.mock.calls[0]?.[0]).toBe("Estado de conexión");
    expect(notifyFn.mock.calls[0]?.[1]).toContain("Total de sesión");

    connection.setState({ connected: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifyFn).toHaveBeenCalledTimes(1);

    stop();
    vi.useRealTimers();
  });
});

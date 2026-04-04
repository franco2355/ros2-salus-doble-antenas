import { CORE_EVENTS } from "../../../../../../core/events/topics";
import type { EventBus } from "../../../../../../core/events/eventBus";
import type { CoreNotificationSettings } from "../../../../../../core/types/settings";
import { DEFAULT_CORE_NOTIFICATION_SETTINGS, loadCoreNotificationSettings } from "../../../../../../core/config/globalNotificationConfig";
import { notify } from "../../../../../../platform/tauri/notifications";
import { isMainWindowFocused } from "../../../../../../platform/tauri/windowFocus";

export const SYSTEM_NOTIFICATION_SERVICE_ID = "service.system-notifications";

const NAV_GOAL_STATUS_SUCCEEDED = 4;

type NotificationType = "route_complete" | "obstacle" | "connection_lost" | "connected_reminder";

interface ConnectionStateLike {
  connected: boolean;
  lastError: string;
  txBytes: number;
  rxBytes: number;
}

interface ConnectionServiceLike {
  getState(): ConnectionStateLike;
  subscribe(listener: (state: ConnectionStateLike) => void): () => void;
}

interface TelemetryEventLike {
  code?: string;
  text: string;
  timestamp: number;
}

interface TelemetrySnapshotLike {
  goalActive: boolean;
  navResultStatus: number;
  navResultText: string;
  navResultEventId: number;
  recentEvents: TelemetryEventLike[];
  alerts: TelemetryEventLike[];
}

interface TelemetryServiceLike {
  getSnapshot(): TelemetrySnapshotLike;
  subscribeTelemetry(callback: (snapshot: TelemetrySnapshotLike) => void): () => void;
}

interface AppRuntimeLike {
  eventBus: EventBus;
  getService<T>(serviceId: string): T;
}

interface StartOptions {
  runtime: AppRuntimeLike;
  getNow?: () => number;
  notifyFn?: (title: string, body: string) => Promise<void>;
  isFocusedFn?: () => Promise<boolean>;
}

function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function messageMatchesObstacle(message: string, keywords: string[]): boolean {
  const normalized = message.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function eventSignature(event: TelemetryEventLike): string {
  return `${event.timestamp}|${event.code ?? ""}|${event.text}`;
}

export class SystemNotificationService {
  private started = false;
  private stopped = false;
  private settings: CoreNotificationSettings = { ...DEFAULT_CORE_NOTIFICATION_SETTINGS };
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];
  private connectionState: ConnectionStateLike | null = null;
  private telemetrySnapshot: TelemetrySnapshotLike | null = null;
  private lastByType = new Map<NotificationType, number>();
  private obstacleSeenOrder: string[] = [];
  private obstacleSeen = new Set<string>();
  private hasWindowFocus = true;
  private pageHidden = false;

  start(options: StartOptions): () => void {
    if (this.started) {
      return () => this.stop();
    }
    this.started = true;
    this.stopped = false;
    const runtime = options.runtime;
    const getNow = options.getNow ?? (() => Date.now());
    const notifyFn = options.notifyFn ?? notify;
    const isFocusedFn = options.isFocusedFn ?? isMainWindowFocused;

    let connectionService: ConnectionServiceLike | null = null;
    let telemetryService: TelemetryServiceLike | null = null;
    try {
      connectionService = runtime.getService<ConnectionServiceLike>("service.connection");
    } catch {
      connectionService = null;
    }
    try {
      telemetryService = runtime.getService<TelemetryServiceLike>("service.telemetry");
    } catch {
      telemetryService = null;
    }

    if (typeof document !== "undefined") {
      this.pageHidden = document.visibilityState === "hidden";
      this.hasWindowFocus = document.hasFocus();
      const onVisibility = (): void => {
        this.pageHidden = document.visibilityState === "hidden";
      };
      const onFocus = (): void => {
        this.hasWindowFocus = true;
      };
      const onBlur = (): void => {
        this.hasWindowFocus = false;
      };
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      this.unsubscribers.push(() => document.removeEventListener("visibilitychange", onVisibility));
      this.unsubscribers.push(() => window.removeEventListener("focus", onFocus));
      this.unsubscribers.push(() => window.removeEventListener("blur", onBlur));
    }

    const applySettings = (next: CoreNotificationSettings): void => {
      this.settings = { ...next };
      this.updateReminderTimer(getNow, notifyFn, isFocusedFn);
    };

    void loadCoreNotificationSettings().then((loaded) => {
      if (this.stopped) return;
      applySettings(loaded);
    });

    this.unsubscribers.push(
      runtime.eventBus.on<{ settings?: unknown }>(CORE_EVENTS.globalNotificationSettingsUpdated, (payload) => {
        const settings = (payload?.settings ?? payload) as CoreNotificationSettings;
        applySettings(settings);
      })
    );

    if (connectionService) {
      this.connectionState = connectionService.getState();
      let previousConnected = this.connectionState.connected;
      this.unsubscribers.push(
        connectionService.subscribe((next) => {
          const wasConnected = previousConnected;
          previousConnected = next.connected;
          this.connectionState = next;
          if (
            this.settings.notifications_enabled &&
            this.settings.notify_on_connection_lost &&
            wasConnected &&
            !next.connected
          ) {
            const reason = next.lastError?.trim();
            const body = reason ? `Se perdió la conexión.\n${reason}` : "Se perdió la conexión con el backend.";
            void this.notifyWithCooldown("connection_lost", "Conexión perdida", body, getNow, notifyFn, isFocusedFn);
          }
          this.updateReminderTimer(getNow, notifyFn, isFocusedFn);
        })
      );
    }

    if (telemetryService) {
      this.telemetrySnapshot = telemetryService.getSnapshot();
      let previous = this.telemetrySnapshot;
      this.unsubscribers.push(
        telemetryService.subscribeTelemetry((next) => {
          const prev = previous;
          previous = next;
          this.telemetrySnapshot = next;
          if (this.settings.notifications_enabled && this.settings.notify_on_route_complete) {
            const transitionedToDone = prev.goalActive && !next.goalActive;
            const succeeded =
              Number(next.navResultStatus) === NAV_GOAL_STATUS_SUCCEEDED ||
              String(next.navResultText ?? "")
                .trim()
                .toUpperCase() === "SUCCEEDED";
            if (transitionedToDone && succeeded) {
              void this.notifyWithCooldown(
                "route_complete",
                "Recorrido completado",
                "El robot completó el recorrido.",
                getNow,
                notifyFn,
                isFocusedFn
              );
            }
          }

          if (this.settings.notifications_enabled && this.settings.notify_on_obstacle) {
            this.handleObstacleNotifications(next, getNow, notifyFn, isFocusedFn);
          }
        })
      );
    }

    this.updateReminderTimer(getNow, notifyFn, isFocusedFn);
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }

  private handleObstacleNotifications(
    snapshot: TelemetrySnapshotLike,
    getNow: () => number,
    notifyFn: (title: string, body: string) => Promise<void>,
    isFocusedFn: () => Promise<boolean>
  ): void {
    const keywords = this.settings.obstacle_keywords ?? [];
    const pool = [...(snapshot.alerts ?? []), ...(snapshot.recentEvents ?? [])];
    for (const event of pool) {
      const signature = eventSignature(event);
      if (this.obstacleSeen.has(signature)) continue;
      this.obstacleSeen.add(signature);
      this.obstacleSeenOrder.push(signature);
      if (this.obstacleSeenOrder.length > 400) {
        const oldest = this.obstacleSeenOrder.shift();
        if (oldest) this.obstacleSeen.delete(oldest);
      }
      const haystack = `${event.code ?? ""} ${event.text ?? ""}`.trim();
      if (!haystack) continue;
      if (!messageMatchesObstacle(haystack, keywords)) continue;
      const code = event.code?.trim() ? `[${event.code.trim()}] ` : "";
      void this.notifyWithCooldown(
        "obstacle",
        "Obstáculo detectado",
        `${code}${event.text}`.trim(),
        getNow,
        notifyFn,
        isFocusedFn
      );
      break;
    }
  }

  private async shouldNotify(isFocusedFn: () => Promise<boolean>): Promise<boolean> {
    if (!this.settings.notifications_enabled) return false;
    if (this.pageHidden) return true;
    if (this.hasWindowFocus) return false;
    const tauriFocused = await isFocusedFn().catch(() => false);
    return !tauriFocused;
  }

  private async notifyWithCooldown(
    type: NotificationType,
    title: string,
    body: string,
    getNow: () => number,
    notifyFn: (title: string, body: string) => Promise<void>,
    isFocusedFn: () => Promise<boolean>
  ): Promise<void> {
    const now = getNow();
    const cooldown = Math.max(5_000, Number(this.settings.notification_cooldown_ms || 30_000));
    const last = this.lastByType.get(type) ?? 0;
    if (now - last < cooldown) return;
    const canNotify = await this.shouldNotify(isFocusedFn);
    if (!canNotify) return;
    await notifyFn(title, body).catch(() => undefined);
    this.lastByType.set(type, now);
  }

  private updateReminderTimer(
    getNow: () => number,
    notifyFn: (title: string, body: string) => Promise<void>,
    isFocusedFn: () => Promise<boolean>
  ): void {
    const enabled = this.settings.notifications_enabled && this.settings.connected_reminder_enabled;
    if (!enabled) {
      if (this.reminderTimer) {
        clearInterval(this.reminderTimer);
        this.reminderTimer = null;
      }
      return;
    }
    const intervalMs = Math.max(60_000, Number(this.settings.connected_reminder_interval_ms || 180_000));
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
    this.reminderTimer = setInterval(() => {
      const connection = this.connectionState;
      if (!connection?.connected) return;
      const total = connection.txBytes + connection.rxBytes;
      const body = `Sigues conectado. Total de sesión: ${formatBytes(total)} (TX ${formatBytes(connection.txBytes)} · RX ${formatBytes(connection.rxBytes)})`;
      void this.notifyWithCooldown("connected_reminder", "Estado de conexión", body, getNow, notifyFn, isFocusedFn);
    }, intervalMs);
  }
}

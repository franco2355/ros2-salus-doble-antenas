import { readConfig, removeConfig, writeConfig } from "../../platform/host/configFs";
import type { CoreNotificationSettings } from "../types/settings";

const CONFIG_PATH = "core/notifications.json";
const MIN_REMINDER_INTERVAL_MS = 60_000;
const MIN_COOLDOWN_MS = 5_000;

export const DEFAULT_CORE_NOTIFICATION_SETTINGS: CoreNotificationSettings = {
  notifications_enabled: true,
  notify_on_route_complete: true,
  notify_on_obstacle: true,
  notify_on_connection_lost: true,
  connected_reminder_enabled: false,
  connected_reminder_interval_ms: 180_000,
  notification_cooldown_ms: 30_000,
  obstacle_keywords: ["obstacle", "blocked", "collision", "stuck", "path_blocked"]
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  return fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.round(parsed));
}

function normalizeKeywords(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const keywords = value
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return keywords.length > 0 ? Array.from(new Set(keywords)) : [...fallback];
}

export function normalizeCoreNotificationSettings(input: unknown): CoreNotificationSettings {
  const value = asRecord(input) ?? {};
  return {
    notifications_enabled: normalizeBoolean(
      value.notifications_enabled,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.notifications_enabled
    ),
    notify_on_route_complete: normalizeBoolean(
      value.notify_on_route_complete,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.notify_on_route_complete
    ),
    notify_on_obstacle: normalizeBoolean(
      value.notify_on_obstacle,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.notify_on_obstacle
    ),
    notify_on_connection_lost: normalizeBoolean(
      value.notify_on_connection_lost,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.notify_on_connection_lost
    ),
    connected_reminder_enabled: normalizeBoolean(
      value.connected_reminder_enabled,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.connected_reminder_enabled
    ),
    connected_reminder_interval_ms: normalizeInteger(
      value.connected_reminder_interval_ms,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.connected_reminder_interval_ms,
      MIN_REMINDER_INTERVAL_MS
    ),
    notification_cooldown_ms: normalizeInteger(
      value.notification_cooldown_ms,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.notification_cooldown_ms,
      MIN_COOLDOWN_MS
    ),
    obstacle_keywords: normalizeKeywords(
      value.obstacle_keywords,
      DEFAULT_CORE_NOTIFICATION_SETTINGS.obstacle_keywords
    )
  };
}

export async function loadCoreNotificationSettings(): Promise<CoreNotificationSettings> {
  const raw = await readConfig(CONFIG_PATH);
  if (!raw) return { ...DEFAULT_CORE_NOTIFICATION_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    return normalizeCoreNotificationSettings(parsed);
  } catch {
    return { ...DEFAULT_CORE_NOTIFICATION_SETTINGS };
  }
}

export async function saveCoreNotificationSettings(input: unknown): Promise<CoreNotificationSettings> {
  const settings = normalizeCoreNotificationSettings(input);
  await writeConfig(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

export async function resetCoreNotificationSettings(): Promise<CoreNotificationSettings> {
  await removeConfig(CONFIG_PATH);
  return { ...DEFAULT_CORE_NOTIFICATION_SETTINGS };
}

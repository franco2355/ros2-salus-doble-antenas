export interface CoreNotificationSettings {
  [key: string]: unknown;
  notifications_enabled: boolean;
  notify_on_route_complete: boolean;
  notify_on_obstacle: boolean;
  notify_on_connection_lost: boolean;
  connected_reminder_enabled: boolean;
  connected_reminder_interval_ms: number;
  notification_cooldown_ms: number;
  obstacle_keywords: string[];
}

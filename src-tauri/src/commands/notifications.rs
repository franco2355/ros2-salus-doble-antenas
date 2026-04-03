use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

#[derive(Serialize, Clone)]
struct NotificationPayload {
  title: String,
  body: String,
}

#[tauri::command]
pub fn notify_system(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
  let payload = NotificationPayload { title, body };
  if let Some(window) = app.get_webview_window("main") {
    window
      .emit("system-notification", payload)
      .map_err(|err| format!("failed to emit notification event: {err}"))?;
  }
  Ok(())
}


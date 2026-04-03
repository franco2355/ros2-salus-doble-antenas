use std::fs;
use std::path::PathBuf;

use tauri::Manager;

fn resolve_config_path(app: &tauri::AppHandle, relative_path: &str) -> Result<PathBuf, String> {
  let config_dir = app
    .path()
    .app_config_dir()
    .map_err(|err| format!("failed to resolve app config dir: {err}"))?;
  Ok(config_dir.join(relative_path))
}

#[tauri::command]
pub fn read_config_file(app: tauri::AppHandle, relative_path: String) -> Result<Option<String>, String> {
  let path = resolve_config_path(&app, &relative_path)?;
  if !path.exists() {
    return Ok(None);
  }
  let content = fs::read_to_string(path).map_err(|err| format!("failed to read config file: {err}"))?;
  Ok(Some(content))
}

#[tauri::command]
pub fn write_config_file(app: tauri::AppHandle, relative_path: String, content: String) -> Result<(), String> {
  let path = resolve_config_path(&app, &relative_path)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| format!("failed to create config parent directory: {err}"))?;
  }
  fs::write(path, content).map_err(|err| format!("failed to write config file: {err}"))?;
  Ok(())
}

#[tauri::command]
pub fn watch_config_file(_app: tauri::AppHandle, _relative_path: String) -> Result<(), String> {
  Ok(())
}

#[tauri::command]
pub fn unwatch_config_file(_app: tauri::AppHandle, _relative_path: String) -> Result<(), String> {
  Ok(())
}


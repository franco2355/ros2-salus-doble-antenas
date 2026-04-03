use tauri::Manager;

#[tauri::command]
pub fn open_aux_window(
  app: tauri::AppHandle,
  label: String,
  route: String,
  title: String,
  width: f64,
  height: f64,
) -> Result<(), String> {
  if app.get_webview_window(&label).is_some() {
    return Ok(());
  }

  tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(route.into()))
    .title(title)
    .inner_size(width, height)
    .build()
    .map_err(|err| format!("failed to create window: {err}"))?;

  Ok(())
}


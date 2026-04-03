#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::config::{read_config_file, unwatch_config_file, watch_config_file, write_config_file};
use commands::notifications::notify_system;
use commands::windows::open_aux_window;

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      notify_system,
      open_aux_window,
      read_config_file,
      write_config_file,
      watch_config_file,
      unwatch_config_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}


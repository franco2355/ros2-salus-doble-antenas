use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct TerminalSessionInfo {
  pub session_id: String,
  pub host: String,
  pub local: bool,
}

#[derive(Serialize, Clone)]
struct TerminalOutputEvent {
  session_id: String,
  data: String,
}

struct TerminalSession {
  _master: Box<dyn MasterPty + Send>,
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send>,
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static TERMINAL_SESSIONS: Lazy<Mutex<HashMap<String, TerminalSession>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn preview_chunk(data: &str, max_chars: usize) -> String {
  let mut preview = data
    .chars()
    .take(max_chars)
    .collect::<String>()
    .replace('\n', "\\n")
    .replace('\r', "\\r");
  if data.chars().count() > max_chars {
    preview.push_str("...");
  }
  preview
}

fn log_command(label: &str, command: &CommandBuilder) {
  let argv = command
    .get_argv()
    .iter()
    .map(|arg| arg.to_string_lossy().to_string())
    .collect::<Vec<_>>()
    .join(" ");
  eprintln!("[terminal-debug] {label}: {argv}");
}

fn default_ssh_config_path() -> String {
  "~/.ssh/config".to_string()
}

fn resolve_term_env() -> String {
  std::env::var("TERM")
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "xterm-256color".to_string())
}

fn apply_terminal_env(command: &mut CommandBuilder) {
  // Desktop launchers (.desktop) often start without TERM, which breaks zsh
  // key bindings based on $terminfo. Always provide a sane terminal type.
  command.env("TERM", resolve_term_env());
}

fn expand_user_path(path: &str) -> PathBuf {
  if let Some(rest) = path.strip_prefix("~/") {
    if let Ok(home) = std::env::var("HOME") {
      return PathBuf::from(home).join(rest);
    }
  }
  PathBuf::from(path)
}

fn resolve_shell(shell_override: Option<String>) -> String {
  if let Some(override_value) = shell_override {
    let trimmed = override_value.trim();
    if !trimmed.is_empty() {
      return trimmed.to_string();
    }
  }

  #[cfg(target_os = "windows")]
  {
    return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
  }

  #[cfg(not(target_os = "windows"))]
  {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
  }
}

fn is_localhost_alias(host: &str) -> bool {
  host.eq_ignore_ascii_case("localhost")
}

fn parse_ssh_hosts(config_text: &str) -> Vec<String> {
  let mut hosts = Vec::new();
  let mut seen = HashSet::new();

  for raw_line in config_text.lines() {
    let line_without_comment = raw_line.split('#').next().unwrap_or("").trim();
    if line_without_comment.is_empty() {
      continue;
    }

    let mut parts = line_without_comment.split_whitespace();
    let directive = parts.next().unwrap_or_default();
    if !directive.eq_ignore_ascii_case("host") {
      continue;
    }

    for token in parts {
      let entry = token.trim();
      if entry.is_empty() {
        continue;
      }
      if entry.contains('*') || entry.contains('?') || entry.starts_with('!') {
        continue;
      }
      if seen.insert(entry.to_string()) {
        hosts.push(entry.to_string());
      }
    }
  }

  hosts
}

fn build_command(
  host: &str,
  ssh_config_path: Option<String>,
  shell_override: Option<String>,
) -> CommandBuilder {
  if is_localhost_alias(host) {
    let shell = resolve_shell(shell_override);
    let mut command = CommandBuilder::new(shell);
    apply_terminal_env(&mut command);
    #[cfg(not(target_os = "windows"))]
    {
      command.arg("-i");
    }
    log_command("local command", &command);
    return command;
  }

  let mut command = CommandBuilder::new("ssh");
  apply_terminal_env(&mut command);
  let config_path = ssh_config_path.unwrap_or_else(default_ssh_config_path);
  let resolved_config_path = expand_user_path(config_path.trim());
  if !config_path.trim().is_empty() {
    command.arg("-F");
    command.arg(resolved_config_path.to_string_lossy().to_string());
  }
  command.arg(host.trim().to_string());
  log_command("ssh command", &command);
  command
}

fn start_session_internal(
  app: Option<AppHandle>,
  host: String,
  ssh_config_path: Option<String>,
  shell_override: Option<String>,
) -> Result<(TerminalSessionInfo, TerminalSession), String> {
  let normalized_host = host.trim().to_string();
  eprintln!(
    "[terminal-debug] start_session host='{}' ssh_config_path={:?} shell_override={:?}",
    normalized_host, ssh_config_path, shell_override
  );
  if normalized_host.is_empty() {
    return Err("Host is required".to_string());
  }

  let pty_system = native_pty_system();
  let pair = pty_system
    .openpty(PtySize {
      rows: 30,
      cols: 120,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| format!("Failed to open PTY: {error}"))?;

  let command = build_command(&normalized_host, ssh_config_path, shell_override);
  let child = pair
    .slave
    .spawn_command(command)
    .map_err(|error| format!("Failed to spawn terminal process: {error}"))?;
  drop(pair.slave);

  let session_id = format!("terminal-{}", NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed));
  let master = pair.master;
  let mut reader = master
    .try_clone_reader()
    .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
  let writer = master
    .take_writer()
    .map_err(|error| format!("Failed to take PTY writer: {error}"))?;

  let session_id_for_thread = session_id.clone();
  std::thread::spawn(move || {
    let mut buffer = [0_u8; 4096];
    let mut chunk_index: u64 = 0;
    loop {
      match reader.read(&mut buffer) {
        Ok(0) => {
          eprintln!(
            "[terminal-debug] output eof session_id={} chunks={}",
            session_id_for_thread, chunk_index
          );
          break;
        }
        Ok(size) => {
          if size == 0 {
            eprintln!(
              "[terminal-debug] output size=0 session_id={} chunks={}",
              session_id_for_thread, chunk_index
            );
            break;
          }
          chunk_index += 1;
          if let Some(app_handle) = app.as_ref() {
            let data = String::from_utf8_lossy(&buffer[..size]).to_string();
            if chunk_index <= 20 || chunk_index % 100 == 0 {
              eprintln!(
                "[terminal-debug] output chunk session_id={} idx={} bytes={} preview='{}'",
                session_id_for_thread,
                chunk_index,
                size,
                preview_chunk(&data, 160)
              );
            }
            match app_handle.emit(
              "terminal-output",
              TerminalOutputEvent {
                session_id: session_id_for_thread.clone(),
                data,
              },
            ) {
              Ok(()) => {
                if chunk_index <= 20 || chunk_index % 100 == 0 {
                  eprintln!(
                    "[terminal-debug] emit ok session_id={} idx={}",
                    session_id_for_thread, chunk_index
                  );
                }
              }
              Err(error) => {
                eprintln!(
                  "[terminal-debug] emit error session_id={} idx={} error={}",
                  session_id_for_thread, chunk_index, error
                );
              }
            }
          }
        }
        Err(error) => {
          eprintln!(
            "[terminal-debug] output read_error session_id={} error={}",
            session_id_for_thread, error
          );
          break;
        }
      }
    }
  });

  eprintln!(
    "[terminal-debug] session started id={} host='{}' local={}",
    session_id,
    normalized_host,
    is_localhost_alias(&normalized_host)
  );
  Ok((
    TerminalSessionInfo {
      session_id,
      host: normalized_host.clone(),
      local: is_localhost_alias(&normalized_host),
    },
    TerminalSession {
      _master: master,
      writer,
      child,
    },
  ))
}

#[tauri::command]
pub fn terminal_start_session(
  app: AppHandle,
  host: String,
  ssh_config_path: Option<String>,
  shell_override: Option<String>,
) -> Result<TerminalSessionInfo, String> {
  let (session_info, session) = start_session_internal(Some(app), host, ssh_config_path, shell_override)?;
  let mut sessions = TERMINAL_SESSIONS
    .lock()
    .map_err(|_| "Terminal session lock poisoned".to_string())?;
  sessions.insert(session_info.session_id.clone(), session);
  Ok(session_info)
}

#[tauri::command]
pub fn terminal_write(session_id: String, data: String) -> Result<(), String> {
  eprintln!(
    "[terminal-debug] write session_id={} bytes={} preview='{}'",
    session_id,
    data.len(),
    preview_chunk(&data, 120)
  );
  let mut sessions = TERMINAL_SESSIONS
    .lock()
    .map_err(|_| "Terminal session lock poisoned".to_string())?;
  let session = sessions
    .get_mut(&session_id)
    .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
  session
    .writer
    .write_all(data.as_bytes())
    .map_err(|error| format!("Failed to write to terminal: {error}"))?;
  session
    .writer
    .flush()
    .map_err(|error| format!("Failed to flush terminal writer: {error}"))?;
  Ok(())
}

#[tauri::command]
pub fn terminal_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
  eprintln!("[terminal-debug] resize session_id={} cols={} rows={}", session_id, cols, rows);
  let mut sessions = TERMINAL_SESSIONS
    .lock()
    .map_err(|_| "Terminal session lock poisoned".to_string())?;
  let session = sessions
    .get_mut(&session_id)
    .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
  session
    ._master
    .resize(PtySize {
      rows: rows.max(2),
      cols: cols.max(2),
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| format!("Failed to resize terminal: {error}"))?;
  Ok(())
}

#[tauri::command]
pub fn terminal_close_session(session_id: String) -> Result<(), String> {
  eprintln!("[terminal-debug] close session_id={}", session_id);
  let mut sessions = TERMINAL_SESSIONS
    .lock()
    .map_err(|_| "Terminal session lock poisoned".to_string())?;
  let mut session = sessions
    .remove(&session_id)
    .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
  let _ = session.child.kill();
  let _ = session.child.wait();
  Ok(())
}

#[tauri::command]
pub fn terminal_list_ssh_hosts(ssh_config_path: Option<String>) -> Result<Vec<String>, String> {
  eprintln!(
    "[terminal-debug] list_ssh_hosts ssh_config_path={:?}",
    ssh_config_path
  );
  let path = ssh_config_path.unwrap_or_else(default_ssh_config_path);
  let resolved = expand_user_path(path.trim());
  if !resolved.exists() {
    eprintln!(
      "[terminal-debug] list_ssh_hosts resolved='{}' not found",
      resolved.to_string_lossy()
    );
    return Ok(Vec::new());
  }
  let text = fs::read_to_string(&resolved)
    .map_err(|error| format!("Failed to read SSH config '{}': {error}", resolved.to_string_lossy()))?;
  let hosts = parse_ssh_hosts(&text);
  eprintln!(
    "[terminal-debug] list_ssh_hosts resolved='{}' count={} hosts={:?}",
    resolved.to_string_lossy(),
    hosts.len(),
    hosts
  );
  Ok(hosts)
}

#[cfg(test)]
mod tests {
  use super::{build_command, parse_ssh_hosts, resolve_shell};

  #[test]
  fn parse_ssh_hosts_extracts_only_explicit_entries() {
    let sample = r#"
Host *
  ForwardAgent no

Host robot-a robot-b
  User ubuntu

Host !blocked *.internal
  User ignored

Host jump-host
"#;

    let hosts = parse_ssh_hosts(sample);
    assert_eq!(hosts, vec!["robot-a", "robot-b", "jump-host"]);
  }

  #[test]
  fn resolve_shell_uses_override_when_present() {
    let shell = resolve_shell(Some("zsh".to_string()));
    assert_eq!(shell, "zsh");
  }

  #[cfg(not(target_os = "windows"))]
  #[test]
  fn build_command_adds_interactive_flag_for_local_shell() {
    let command = build_command("Localhost", None, Some("/bin/bash".to_string()));
    let argv = command.get_argv();
    assert_eq!(argv[0].to_string_lossy(), "/bin/bash");
    assert_eq!(argv[1].to_string_lossy(), "-i");
  }

  #[cfg(not(target_os = "windows"))]
  #[test]
  fn build_command_sets_term_for_local_shell() {
    let command = build_command("Localhost", None, Some("/bin/bash".to_string()));
    let term = command
      .get_env("TERM")
      .and_then(|value| value.to_str())
      .unwrap_or_default()
      .to_string();
    assert!(!term.trim().is_empty());
  }

  #[test]
  fn build_command_sets_term_for_ssh() {
    let command = build_command("robot-a", Some("~/.ssh/config".to_string()), None);
    let term = command
      .get_env("TERM")
      .and_then(|value| value.to_str())
      .unwrap_or_default()
      .to_string();
    assert!(!term.trim().is_empty());
  }
}

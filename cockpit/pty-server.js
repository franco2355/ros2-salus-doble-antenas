// PTY WebSocket server — each WS connection spawns an isolated bash shell
import { createServer } from "http";
import { WebSocketServer } from "ws";
import * as pty from "node-pty";
import { homedir, platform } from "os";

const PORT = 7681;
const SHELL = platform() === "win32" ? "cmd.exe" : (process.env.SHELL ?? "/bin/bash");
const LOCAL_CWD = process.env.PTY_CWD ?? process.env.HOME ?? homedir() ?? "/";
const REMOTE_HOST = process.env.PTY_REMOTE_HOST ?? "salus";
const REMOTE_CWD = process.env.PTY_REMOTE_CWD ?? "~/ros2_ws";
const KNOWN_TARGETS = new Set(["local", "salus"]);
const CWD_OSC_PROMPT_COMMAND = 'printf "\\033]7;file://%s%s\\007" "$(hostname 2>/dev/null || printf local)" "$PWD"';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeTarget(value) {
  const target = String(value || "local").trim().toLowerCase();
  return KNOWN_TARGETS.has(target) ? target : "local";
}

function localCwdFromRequest(value) {
  const cwd = String(value || "").trim();
  return cwd.startsWith("/") ? cwd : LOCAL_CWD;
}

function remoteCwdFromRequest(value) {
  const cwd = String(value || "").trim();
  if (!cwd || cwd === LOCAL_CWD) return REMOTE_CWD;
  return cwd;
}

function cdCommand(cwd) {
  const path = String(cwd || "").trim();
  if (path === "~") return "cd ~";
  if (path.startsWith("~/")) return `cd ~/${shellQuote(path.slice(2))}`;
  return `cd ${shellQuote(path || ".")}`;
}

function bashArgsForTarget(target, cwd) {
  const label = target === "salus" ? "salus" : "local";
  const prompt = target === "salus"
    ? "\\[\\e[36m\\]\\u@salus\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ "
    : "\\[\\e[32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ ";
  const setup = [
    `${cdCommand(cwd)} 2>/dev/null || cd ~`,
    "export TERM=xterm-256color",
    "export COLORTERM=truecolor",
    "eval \"$(dircolors -b 2>/dev/null || true)\"",
    "alias ls='ls --color=auto'",
    "alias ll='ls -lah --color=auto'",
    `export PS1=${shellQuote(prompt)}`,
    `export PROMPT_COMMAND=${shellQuote(CWD_OSC_PROMPT_COMMAND)}`,
    `printf "\\033]7;file://${label}%s\\007" "$PWD"`,
    "exec bash --noprofile --norc -i",
  ].join("; ");
  return ["--noprofile", "--norc", "-lc", setup];
}

function spawnConfig(req) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = normalizeTarget(url.searchParams.get("target"));
  const requestedCwd = url.searchParams.get("cwd");

  if (target === "salus") {
    const cwd = remoteCwdFromRequest(requestedCwd);
    const remoteCommand = ["bash", ...bashArgsForTarget("salus", cwd)].map(shellQuote).join(" ");
    return {
      command: "ssh",
      args: ["-tt", REMOTE_HOST, remoteCommand],
      cwd: LOCAL_CWD,
    };
  }

  const cwd = localCwdFromRequest(requestedCwd);
  return {
    command: SHELL,
    args: bashArgsForTarget("local", cwd),
    cwd,
  };
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PTY server running\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const config = spawnConfig(req);
  const term = pty.spawn(config.command, config.args, {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd: config.cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (msg) => {
    const text = msg.toString();
    // Resize message: {"type":"resize","cols":N,"rows":N}
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "resize") {
        term.resize(Math.max(1, parsed.cols), Math.max(1, parsed.rows));
        return;
      }
    } catch {
      // not JSON — treat as raw input
    }
    term.write(text);
  });

  ws.on("close", () => term.kill());
  ws.on("error", () => term.kill());
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`PTY server listening on ws://127.0.0.1:${PORT}`);
});

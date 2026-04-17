#!/usr/bin/env node

const WebSocket = require("ws");

const DEFAULTS = {
  devtoolsPort: 9222,
  driveMs: 10000,
  patrolObserveMs: 4000,
  minWaypoints: 2,
  waitTimeoutMs: 12000,
  pageUrlHint: "index.html",
};

function parseArgs(argv) {
  const config = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      config.help = true;
      continue;
    }
    if (arg.startsWith("--devtools-port=")) {
      config.devtoolsPort = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg.startsWith("--drive-ms=")) {
      config.driveMs = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg.startsWith("--patrol-observe-ms=")) {
      config.patrolObserveMs = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg.startsWith("--min-waypoints=")) {
      config.minWaypoints = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg.startsWith("--wait-timeout-ms=")) {
      config.waitTimeoutMs = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg.startsWith("--page-url-hint=")) {
      config.pageUrlHint = String(arg.split("=", 2)[1] || "").trim() || DEFAULTS.pageUrlHint;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  return config;
}

function usage() {
  return [
    "Usage: node tools/test_page_patrol_sim.js [options]",
    "",
    "Options:",
    "  --devtools-port=9222",
    "  --drive-ms=10000",
    "  --patrol-observe-ms=4000",
    "  --min-waypoints=2",
    "  --wait-timeout-ms=12000",
    "  --page-url-hint=index.html",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ChromePageDriver {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.pending = new Map();
    this.nextId = 1;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.ws.removeListener("open", onOpen);
        reject(err);
      };
      const onOpen = () => {
        this.ws.removeListener("error", onError);
        resolve();
      };
      this.ws.once("error", onError);
      this.ws.once("open", onOpen);
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id == null) {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || "cdp error"));
        return;
      }
      entry.resolve(msg.result || {});
    });

    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  close() {
    this.ws.close();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.result ? result.result.value : undefined;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.json();
}

async function findPageWsUrl(config) {
  const targets = await fetchJson(
    `http://127.0.0.1:${config.devtoolsPort}/json/list`
  );
  const hint = String(config.pageUrlHint || "").trim();
  const pageTarget = targets.find(
    (target) =>
      target &&
      target.type === "page" &&
      typeof target.webSocketDebuggerUrl === "string" &&
      String(target.url || "").includes(hint)
  );
  if (!pageTarget) {
    throw new Error(
      `page target not found in Chrome DevTools (hint=${JSON.stringify(hint)})`
    );
  }
  return pageTarget.webSocketDebuggerUrl;
}

async function waitFor(driver, label, predicateExpr, timeoutMs) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const value = await driver.evaluate(predicateExpr);
    if (value) {
      return value;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function snapshot(driver) {
  return driver.evaluate(`(() => ({
    connectionState: document.getElementById('connectionState')?.textContent || '',
    status: document.getElementById('status')?.textContent || '',
    waypointStatus: document.getElementById('waypointStatus')?.textContent || '',
    recordingStatus: document.getElementById('recordingStatus')?.textContent || '',
    patrolStatus: document.getElementById('patrolStatus')?.textContent || '',
    manualStatus: document.getElementById('manualStatus')?.textContent || ''
  }))()`);
}

async function click(driver, id) {
  const ok = await driver.evaluate(
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      el.click();
      return true;
    })()`
  );
  if (!ok) {
    throw new Error(`button not found: ${id}`);
  }
}

async function dispatchKey(driver, eventType, code, key) {
  await driver.evaluate(
    `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(eventType)}, {
      code: ${JSON.stringify(code)},
      key: ${JSON.stringify(key)},
      bubbles: true
    }))`
  );
}

async function ensureConnected(driver, timeoutMs) {
  let state = await snapshot(driver);
  if (state.connectionState === "connected") {
    return state;
  }
  await driver.evaluate(
    "(() => { applyConnectionPreset('sim'); connectWs(); return true; })()"
  );
  await waitFor(
    driver,
    "connectionState connected",
    "document.getElementById('connectionState') && document.getElementById('connectionState').textContent === 'connected'",
    timeoutMs
  );
  return snapshot(driver);
}

async function ensureManualOff(driver, timeoutMs) {
  const state = await snapshot(driver);
  if (!state.manualStatus.includes("Manual: ON")) {
    return;
  }
  await click(driver, "manualModeBtn");
  await waitFor(
    driver,
    "manual mode OFF",
    "document.getElementById('manualStatus') && document.getElementById('manualStatus').textContent.includes('Manual: OFF')",
    timeoutMs
  );
}

async function ensurePatrolStopped(driver, timeoutMs) {
  const state = await snapshot(driver);
  if (!state.patrolStatus.includes("Patrol: active")) {
    return;
  }
  await click(driver, "stopPatrolBtn");
  await waitFor(
    driver,
    "patrol idle",
    "document.getElementById('patrolStatus') && document.getElementById('patrolStatus').textContent.includes('Patrol: idle')",
    timeoutMs
  );
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    console.log(usage());
    return;
  }

  const wsUrl = await findPageWsUrl(config);
  const driver = new ChromePageDriver(wsUrl);
  await driver.open();
  try {
    await waitFor(
      driver,
      "page ready",
      "document.readyState === 'complete'",
      config.waitTimeoutMs
    );

    const connected = await ensureConnected(driver, config.waitTimeoutMs);
    console.log("connected", JSON.stringify(connected));

    await ensureManualOff(driver, config.waitTimeoutMs);
    await ensurePatrolStopped(driver, config.waitTimeoutMs);

    await click(driver, "clearRecordingBtn");
    await click(driver, "startRecordingBtn");
    await waitFor(
      driver,
      "recording active",
      "document.getElementById('recordingStatus') && document.getElementById('recordingStatus').textContent.includes('Recorder: recording')",
      config.waitTimeoutMs
    );

    await click(driver, "manualModeBtn");
    await waitFor(
      driver,
      "manual mode ON",
      "document.getElementById('manualStatus') && document.getElementById('manualStatus').textContent.includes('Manual: ON')",
      config.waitTimeoutMs
    );
    await dispatchKey(driver, "keydown", "KeyW", "w");
    await sleep(config.driveMs);
    await dispatchKey(driver, "keyup", "KeyW", "w");
    await sleep(1200);

    await click(driver, "manualModeBtn");
    await waitFor(
      driver,
      "manual mode OFF",
      "document.getElementById('manualStatus') && document.getElementById('manualStatus').textContent.includes('Manual: OFF')",
      config.waitTimeoutMs
    );

    await waitFor(
      driver,
      `recording count >= ${config.minWaypoints}`,
      `(() => {
        const text = document.getElementById('recordingStatus')?.textContent || '';
        const match = text.match(/count=(\\d+)/);
        return match ? Number(match[1]) >= ${Math.max(1, Number(config.minWaypoints) || 1)} : false;
      })()`,
      config.waitTimeoutMs
    );

    await click(driver, "stopRecordingBtn");
    await waitFor(
      driver,
      "recording idle",
      "document.getElementById('recordingStatus') && document.getElementById('recordingStatus').textContent.includes('Recorder: idle')",
      config.waitTimeoutMs
    );
    const afterRecording = await snapshot(driver);
    console.log("after-recording", JSON.stringify(afterRecording));

    await click(driver, "startPatrolBtn");
    await waitFor(
      driver,
      "patrol active",
      "document.getElementById('patrolStatus') && document.getElementById('patrolStatus').textContent.includes('Patrol: active')",
      config.waitTimeoutMs
    );
    await sleep(config.patrolObserveMs);
    const duringPatrol = await snapshot(driver);
    console.log("during-patrol", JSON.stringify(duringPatrol));

    await click(driver, "stopPatrolBtn");
    await waitFor(
      driver,
      "patrol idle after stop",
      "document.getElementById('patrolStatus') && document.getElementById('patrolStatus').textContent.includes('Patrol: idle')",
      config.waitTimeoutMs
    );
    const finalState = await snapshot(driver);
    console.log("final", JSON.stringify(finalState));
  } finally {
    driver.close();
  }
}

main().catch((err) => {
  console.error("fatal", err.message);
  process.exit(1);
});

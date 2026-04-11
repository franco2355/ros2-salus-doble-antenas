import * as vscode from "vscode";
import { readFile } from "node:fs/promises";

const EXTENSION_PREFIX = "cockpit";
const STORAGE_PREFIX = `${EXTENSION_PREFIX}.config.`;

type CockpitSlot = "full";
type SidebarSection = "connection" | "navigation" | "telemetry";

const VIEW_ID_SIDEBAR_CONNECTION = "cockpit.sidebar.connection";
const VIEW_ID_SIDEBAR_NAVIGATION = "cockpit.sidebar.navigation";
const VIEW_ID_SIDEBAR_TELEMETRY = "cockpit.sidebar.telemetry";

const COMMAND_OPEN = "cockpit.open";
const COMMAND_WORKSPACE_OPEN = "cockpit.workspace.open";
const COMMAND_MODAL_OPEN = "cockpit.modal.open";
const COMMAND_TOOLBAR_SHOW = "cockpit.toolbar.show";
const COMMAND_TERMINAL_TOGGLE = "cockpit.terminal.toggle";
const COMMAND_TERMINAL_NEW = "cockpit.terminal.new";
const COMMAND_FOCUS_SIDEBAR_CONTAINER = "cockpit.sidebar.focus";
const COMMAND_FOCUS_CONSOLE_CONTAINER = "cockpit.console.focus";

const COMMAND_SIDEBAR_CONNECTION_CONNECT = "cockpit.sidebar.connection.connect";
const COMMAND_SIDEBAR_CONNECTION_DISCONNECT = "cockpit.sidebar.connection.disconnect";
const COMMAND_SIDEBAR_CONNECTION_PRESET_REAL = "cockpit.sidebar.connection.preset.real";
const COMMAND_SIDEBAR_CONNECTION_PRESET_SIM = "cockpit.sidebar.connection.preset.sim";
const COMMAND_SIDEBAR_CONNECTION_SET_HOST = "cockpit.sidebar.connection.setHost";
const COMMAND_SIDEBAR_CONNECTION_SET_PORT = "cockpit.sidebar.connection.setPort";
const COMMAND_SIDEBAR_NAV_TOGGLE_GOAL = "cockpit.sidebar.navigation.toggleGoalMode";
const COMMAND_SIDEBAR_NAV_TOGGLE_MANUAL = "cockpit.sidebar.navigation.toggleManualMode";
const COMMAND_SIDEBAR_NAV_SNAPSHOT = "cockpit.sidebar.navigation.openSnapshot";
const COMMAND_SIDEBAR_NAV_INFO = "cockpit.sidebar.navigation.openInfo";
const COMMAND_SIDEBAR_NAV_SWAP = "cockpit.sidebar.navigation.swapWorkspace";
const COMMAND_SIDEBAR_TELEMETRY_OUTPUT = "cockpit.sidebar.telemetry.openOutput";

const RUNTIME_CONNECTION_CONNECT = "nav2.navigation.connectionConnect";
const RUNTIME_CONNECTION_DISCONNECT = "nav2.navigation.connectionDisconnect";
const RUNTIME_CONNECTION_SET_PRESET = "nav2.navigation.connectionSetPreset";
const RUNTIME_CONNECTION_SET_HOST = "nav2.navigation.connectionSetHost";
const RUNTIME_CONNECTION_SET_PORT = "nav2.navigation.connectionSetPort";
const RUNTIME_NAV_TOGGLE_GOAL = "nav2.navigation.toggleGoalMode";
const RUNTIME_NAV_TOGGLE_MANUAL = "nav2.navigation.toggleManualMode";
const RUNTIME_NAV_OPEN_SNAPSHOT = "nav2.navigation.openSnapshotModal";
const RUNTIME_NAV_OPEN_INFO = "nav2.navigation.openInfoModal";
const RUNTIME_NAV_SWAP = "nav2.navigation.swapWorkspace";

const CONTEXT_MAIN_OPEN = "cockpit.mainOpen";
const CONTEXT_MAIN_FOCUSED = "cockpit.mainFocused";

interface HostRequestMessage {
  type: "host.request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface HostResponseMessage {
  type: "host.response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ProjectionMessage {
  type: "cockpit.projection";
  slot: "toolbar" | "footer";
  entries: Array<Record<string, unknown>>;
}

interface SidebarSnapshotMessage {
  type: "cockpit.sidebar.snapshot";
  section: SidebarSection;
  data: Record<string, unknown>;
}

interface ConsoleEventMessage {
  type: "cockpit.console.event";
  level: string;
  text: string;
  timestamp: number;
  source?: string;
}

interface HostCommandMessage {
  type: "cockpit.host.command";
  commandId?: string;
  args?: unknown[];
  activateWorkspaceId?: string;
  activateConsoleId?: string;
  openModalId?: string;
}

let workspacePanel: vscode.WebviewPanel | null = null;
let activeTerminal: vscode.Terminal | null = null;
let cockpitOutputChannel: vscode.OutputChannel | null = null;
let webviewReady = false;
let sidebarAutoOpened = false;

const toolbarProjection: Array<Record<string, unknown>> = [];
const footerStatusBarById = new Map<string, vscode.StatusBarItem>();
const pendingHostCommands: HostCommandMessage[] = [];
const sidebarSnapshots: Record<SidebarSection, Record<string, unknown>> = {
  connection: {},
  navigation: {},
  telemetry: {}
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStorageTarget(context: vscode.ExtensionContext): vscode.Memento {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? context.workspaceState
    : context.globalState;
}

function getConfigFromSettings(relativePath: string): string | undefined {
  const configMap = vscode.workspace.getConfiguration("cockpit").get<Record<string, string>>("config", {});
  const value = configMap[relativePath];
  return typeof value === "string" ? value : undefined;
}

async function readConfig(context: vscode.ExtensionContext, relativePath: string): Promise<string | null> {
  const settingValue = getConfigFromSettings(relativePath);
  if (typeof settingValue === "string") return settingValue;
  const storage = getStorageTarget(context);
  const stored = storage.get<string>(`${STORAGE_PREFIX}${relativePath}`);
  return typeof stored === "string" ? stored : null;
}

async function writeConfig(context: vscode.ExtensionContext, relativePath: string, content: string): Promise<void> {
  const storage = getStorageTarget(context);
  await storage.update(`${STORAGE_PREFIX}${relativePath}`, content);
}

async function removeConfig(context: vscode.ExtensionContext, relativePath: string): Promise<void> {
  const storage = getStorageTarget(context);
  await storage.update(`${STORAGE_PREFIX}${relativePath}`, undefined);
}

function createNonce(length = 24): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

async function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, slot: CockpitSlot): Promise<string> {
  const distUri = vscode.Uri.joinPath(extensionUri, "dist");
  const indexUri = vscode.Uri.joinPath(distUri, "index.html");
  const nonce = createNonce();

  let html = await readFile(indexUri.fsPath, "utf8");

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: http: data:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${webview.cspSource} https: http: ws: wss: data:`,
    "frame-src https: http:"
  ].join("; ");

  html = html.replace(
    /<meta\s+charset="UTF-8"\s*\/?\s*>/i,
    `<meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="${csp}">`
  );

  html = html.replace(/(src|href)="\/?assets\/([^"#?]+)"/g, (_match, attr: string, assetPath: string) => {
    const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", assetPath));
    return `${attr}="${resourceUri.toString()}"`;
  });

  html = html.replace(/<script\s+type="module"\s+crossorigin\s+src=/g, `<script nonce="${nonce}" type="module" src=`);
  html = html.replace(/<script\s+type="module"\s+src=/g, `<script nonce="${nonce}" type="module" src=`);

  const slotBootScript = `<script nonce="${nonce}">window.__COCKPIT_WEBVIEW_SLOT__=${JSON.stringify(slot)};</script>`;
  html = html.replace(/<body>/i, `<body>${slotBootScript}`);

  return html;
}

function toHostResponse(id: string, result: unknown): HostResponseMessage {
  return {
    type: "host.response",
    id,
    ok: true,
    result
  };
}

function toHostError(id: string, error: unknown): HostResponseMessage {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Unhandled host error";
  return {
    type: "host.response",
    id,
    ok: false,
    error: message
  };
}

function parseHostRequest(payload: unknown): HostRequestMessage | null {
  const record = asRecord(payload);
  if (!record) return null;
  if (record.type !== "host.request") return null;
  if (typeof record.id !== "string" || typeof record.method !== "string") return null;
  const params = asRecord(record.params) ?? undefined;
  return {
    type: "host.request",
    id: record.id,
    method: record.method,
    params
  };
}

function parseProjectionMessage(payload: unknown): ProjectionMessage | null {
  const record = asRecord(payload);
  if (!record || record.type !== "cockpit.projection") return null;
  if (record.slot !== "toolbar" && record.slot !== "footer") return null;
  if (!Array.isArray(record.entries)) return null;
  return {
    type: "cockpit.projection",
    slot: record.slot,
    entries: record.entries.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
  };
}

function parseSidebarSnapshotMessage(payload: unknown): SidebarSnapshotMessage | null {
  const record = asRecord(payload);
  if (!record || record.type !== "cockpit.sidebar.snapshot") return null;
  if (record.section !== "connection" && record.section !== "navigation" && record.section !== "telemetry") return null;
  const data = asRecord(record.data);
  if (!data) return null;
  return {
    type: "cockpit.sidebar.snapshot",
    section: record.section,
    data
  };
}

function parseConsoleEventMessage(payload: unknown): ConsoleEventMessage | null {
  const record = asRecord(payload);
  if (!record || record.type !== "cockpit.console.event") return null;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return null;
  const level = typeof record.level === "string" ? record.level.toLowerCase() : "info";
  const timestampRaw = Number(record.timestamp);
  return {
    type: "cockpit.console.event",
    level,
    text,
    timestamp: Number.isFinite(timestampRaw) ? timestampRaw : Date.now(),
    source: typeof record.source === "string" ? record.source : undefined
  };
}

async function setCockpitContext(key: string, value: unknown): Promise<void> {
  await vscode.commands.executeCommand("setContext", key, value);
}

function forwardHostCommand(payload: Omit<HostCommandMessage, "type">): void {
  const message: HostCommandMessage = {
    type: "cockpit.host.command",
    ...payload
  };

  if (!workspacePanel || !webviewReady) {
    pendingHostCommands.push(message);
    return;
  }

  void workspacePanel.webview.postMessage(message);
}

function flushPendingHostCommands(): void {
  if (!workspacePanel || !webviewReady || pendingHostCommands.length === 0) return;
  const queue = pendingHostCommands.splice(0, pendingHostCommands.length);
  for (const message of queue) {
    void workspacePanel.webview.postMessage(message);
  }
}

function commandLabelFromProjection(entry: Record<string, unknown>): string {
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const id = typeof entry.id === "string" ? entry.id : "command";
  return label.length > 0 ? label : id;
}

async function showToolbarPicker(): Promise<void> {
  if (toolbarProjection.length === 0) {
    void vscode.window.showInformationMessage("Cockpit: no hay acciones de toolbar proyectadas todavía.");
    return;
  }

  const picks: Array<vscode.QuickPickItem & { commandId?: string; args?: unknown[] }> = [];

  for (const entry of toolbarProjection) {
    const label = commandLabelFromProjection(entry);
    const menuItems = Array.isArray(entry.items) ? entry.items : [];
    const entryCommandId = typeof entry.commandId === "string" ? entry.commandId : undefined;

    if (entryCommandId) {
      picks.push({
        label,
        description: "Toolbar",
        commandId: entryCommandId,
        args: []
      });
    }

    for (const item of menuItems) {
      const itemRecord = asRecord(item);
      if (!itemRecord) continue;
      const itemLabel = typeof itemRecord.label === "string" ? itemRecord.label : "item";
      const commandId = typeof itemRecord.commandId === "string" ? itemRecord.commandId : undefined;
      if (!commandId) continue;
      picks.push({
        label: `${label}: ${itemLabel}`,
        description: "Toolbar item",
        commandId,
        args: []
      });
    }
  }

  if (picks.length === 0) {
    void vscode.window.showInformationMessage("Cockpit: toolbar sin comandos ejecutables.");
    return;
  }

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: "Selecciona acción de Cockpit"
  });
  if (!selected?.commandId) return;
  forwardHostCommand({
    commandId: selected.commandId,
    args: selected.args ?? []
  });
}

function isFooterProjectionSuppressed(id: string): boolean {
  if (id.endsWith(".footer.connection-status")) return true;
  if (id.endsWith(".footer.metrics")) return true;
  return false;
}

function footerTextForEntry(entry: Record<string, unknown>): string {
  const id = typeof entry.id === "string" ? entry.id : "footer.item";
  return `$(circle-large-outline) ${id}`;
}

function applyFooterProjection(entries: Array<Record<string, unknown>>): void {
  const seen = new Set<string>();

  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id || isFooterProjectionSuppressed(id)) continue;
    seen.add(id);

    const alignRaw = typeof entry.align === "string" ? entry.align : "left";
    const align = alignRaw === "right" ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const priorityRaw = Number(entry.statusBarPriority ?? entry.order ?? 0);
    const priority = Number.isFinite(priorityRaw) ? priorityRaw : 0;

    const existing = footerStatusBarById.get(id);
    if (existing) {
      existing.text = footerTextForEntry(entry);
      existing.command = COMMAND_TOOLBAR_SHOW;
      existing.tooltip = `Cockpit footer: ${id}`;
      existing.show();
      continue;
    }

    const item = vscode.window.createStatusBarItem(align, priority);
    item.name = `Cockpit Footer ${id}`;
    item.text = footerTextForEntry(entry);
    item.command = COMMAND_TOOLBAR_SHOW;
    item.tooltip = `Cockpit footer: ${id}`;
    item.show();
    footerStatusBarById.set(id, item);
  }

  for (const [id, item] of footerStatusBarById.entries()) {
    if (seen.has(id)) continue;
    item.dispose();
    footerStatusBarById.delete(id);
  }
}

async function handleHostRequest(context: vscode.ExtensionContext, request: HostRequestMessage): Promise<HostResponseMessage> {
  const params = request.params ?? {};

  switch (request.method) {
    case "host.config.read": {
      const relativePath = typeof params.relativePath === "string" ? params.relativePath : "";
      const result = await readConfig(context, relativePath);
      return toHostResponse(request.id, result);
    }

    case "host.config.write": {
      const relativePath = typeof params.relativePath === "string" ? params.relativePath : "";
      const content = typeof params.content === "string" ? params.content : "";
      await writeConfig(context, relativePath, content);
      return toHostResponse(request.id, true);
    }

    case "host.config.remove": {
      const relativePath = typeof params.relativePath === "string" ? params.relativePath : "";
      await removeConfig(context, relativePath);
      return toHostResponse(request.id, true);
    }

    case "host.notify": {
      const title = typeof params.title === "string" ? params.title : "Cockpit";
      const body = typeof params.body === "string" ? params.body : "";
      const text = body.trim().length > 0 ? `${title}: ${body}` : title;
      void vscode.window.showInformationMessage(text);
      return toHostResponse(request.id, true);
    }

    case "host.dialog.alert": {
      const title = typeof params.title === "string" && params.title.trim().length > 0 ? params.title.trim() : "Notice";
      const message = typeof params.message === "string" ? params.message : "";
      const confirmLabel =
        typeof params.confirmLabel === "string" && params.confirmLabel.trim().length > 0
          ? params.confirmLabel.trim()
          : "OK";
      const danger = params.danger === true;
      if (danger) {
        await vscode.window.showWarningMessage(title, { modal: true, detail: message }, confirmLabel);
      } else {
        await vscode.window.showInformationMessage(title, { modal: true, detail: message }, confirmLabel);
      }
      return toHostResponse(request.id, true);
    }

    case "host.dialog.confirm": {
      const title = typeof params.title === "string" && params.title.trim().length > 0 ? params.title.trim() : "Confirm";
      const message = typeof params.message === "string" ? params.message : "";
      const confirmLabel =
        typeof params.confirmLabel === "string" && params.confirmLabel.trim().length > 0
          ? params.confirmLabel.trim()
          : "Confirm";
      const cancelLabel =
        typeof params.cancelLabel === "string" && params.cancelLabel.trim().length > 0
          ? params.cancelLabel.trim()
          : "Cancel";
      const danger = params.danger === true;
      const selected = danger
        ? await vscode.window.showWarningMessage(title, { modal: true, detail: message }, confirmLabel, cancelLabel)
        : await vscode.window.showInformationMessage(title, { modal: true, detail: message }, confirmLabel, cancelLabel);
      return toHostResponse(request.id, selected === confirmLabel);
    }

    case "host.dialog.prompt": {
      const title =
        typeof params.title === "string" && params.title.trim().length > 0 ? params.title.trim() : "Input required";
      const message = typeof params.message === "string" ? params.message : "";
      const defaultValue = typeof params.defaultValue === "string" ? params.defaultValue : "";
      const placeholder = typeof params.placeholder === "string" ? params.placeholder : "";
      const value = await vscode.window.showInputBox({
        title,
        prompt: message,
        value: defaultValue,
        placeHolder: placeholder,
        ignoreFocusOut: true
      });
      return toHostResponse(request.id, value ?? null);
    }

    case "host.focus.isFocused": {
      return toHostResponse(request.id, vscode.window.state.focused);
    }

    case "host.terminal.open": {
      const options: vscode.TerminalOptions = {
        name: typeof params.name === "string" && params.name.trim().length > 0 ? params.name : "Cockpit"
      };
      if (typeof params.cwd === "string" && params.cwd.trim().length > 0) {
        options.cwd = params.cwd;
      }
      if (typeof params.shellPath === "string" && params.shellPath.trim().length > 0) {
        options.shellPath = params.shellPath;
      }
      if (Array.isArray(params.shellArgs)) {
        options.shellArgs = params.shellArgs.filter((arg): arg is string => typeof arg === "string");
      }
      activeTerminal = vscode.window.createTerminal(options);
      activeTerminal.show();
      return toHostResponse(request.id, true);
    }

    case "host.terminal.sendText": {
      const text = typeof params.text === "string" ? params.text : "";
      const addNewLine = params.addNewLine !== false;
      if (!activeTerminal) {
        activeTerminal = vscode.window.createTerminal({ name: "Cockpit" });
      }
      activeTerminal.show();
      activeTerminal.sendText(text, addNewLine);
      return toHostResponse(request.id, true);
    }

    case "host.terminal.reveal": {
      const preserveFocus = params.preserveFocus === true;
      if (!activeTerminal) {
        activeTerminal = vscode.window.createTerminal({ name: "Cockpit" });
      }
      activeTerminal.show(preserveFocus);
      return toHostResponse(request.id, true);
    }

    default:
      return toHostError(request.id, `Unsupported host method: ${request.method}`);
  }
}

function getOutputChannel(): vscode.OutputChannel {
  if (cockpitOutputChannel) return cockpitOutputChannel;
  cockpitOutputChannel = vscode.window.createOutputChannel("Cockpit");
  return cockpitOutputChannel;
}

function formatConsoleTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function appendConsoleEvent(event: ConsoleEventMessage): void {
  const source = event.source ? `[${event.source}] ` : "";
  const line = `[${formatConsoleTimestamp(event.timestamp)}] [${event.level.toUpperCase()}] ${source}${event.text}`;
  getOutputChannel().appendLine(line);
}

function getSnapshotString(snapshot: Record<string, unknown>, key: string, fallback = "n/a"): string {
  const value = snapshot[key];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getSnapshotBoolean(snapshot: Record<string, unknown>, key: string): boolean {
  return snapshot[key] === true;
}

function getSnapshotNumber(snapshot: Record<string, unknown>, key: string): number | null {
  const value = Number(snapshot[key]);
  return Number.isFinite(value) ? value : null;
}

function createInfoItem(label: string, description?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (description && description.trim().length > 0) {
    item.description = description;
  }
  item.contextValue = "cockpit.info";
  return item;
}

function createActionItem(label: string, command: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = {
    command,
    title: label
  };
  item.contextValue = "cockpit.action";
  return item;
}

function buildConnectionTreeItems(): vscode.TreeItem[] {
  const snapshot = sidebarSnapshots.connection;
  const connected = getSnapshotBoolean(snapshot, "connected");
  const connecting = getSnapshotBoolean(snapshot, "connecting");
  const preset = getSnapshotString(snapshot, "preset", "real");
  const endpoint = getSnapshotString(snapshot, "endpoint", "n/a");
  const lastError = getSnapshotString(snapshot, "lastError", "");

  const items: vscode.TreeItem[] = [
    createInfoItem("Status", connecting ? "connecting" : connected ? "connected" : "disconnected"),
    createInfoItem("Endpoint", endpoint),
    createInfoItem("Preset", preset),
    createActionItem("$(plug) Connect", COMMAND_SIDEBAR_CONNECTION_CONNECT),
    createActionItem("$(debug-disconnect) Disconnect", COMMAND_SIDEBAR_CONNECTION_DISCONNECT),
    createActionItem("$(broadcast) Preset Real", COMMAND_SIDEBAR_CONNECTION_PRESET_REAL),
    createActionItem("$(device-camera-video) Preset Sim", COMMAND_SIDEBAR_CONNECTION_PRESET_SIM),
    createActionItem("$(edit) Set Host", COMMAND_SIDEBAR_CONNECTION_SET_HOST),
    createActionItem("$(symbol-number) Set Port", COMMAND_SIDEBAR_CONNECTION_SET_PORT)
  ];

  if (lastError) {
    items.splice(3, 0, createInfoItem("Last error", lastError));
  }

  return items;
}

function buildNavigationTreeItems(): vscode.TreeItem[] {
  const snapshot = sidebarSnapshots.navigation;
  const goalMode = getSnapshotBoolean(snapshot, "goalMode");
  const manualMode = getSnapshotBoolean(snapshot, "manualMode");
  const controlLocked = getSnapshotBoolean(snapshot, "controlLocked");
  const controlLockReason = getSnapshotString(snapshot, "controlLockReason", "n/a");
  const selectedWaypoints = getSnapshotNumber(snapshot, "selectedWaypoints") ?? 0;
  const cameraConnected = getSnapshotBoolean(snapshot, "cameraConnected");

  return [
    createInfoItem("Goal mode", goalMode ? "enabled" : "disabled"),
    createInfoItem("Manual mode", manualMode ? "enabled" : "disabled"),
    createInfoItem("Control lock", controlLocked ? `locked (${controlLockReason})` : "unlocked"),
    createInfoItem("Selected waypoints", String(selectedWaypoints)),
    createInfoItem("Camera", cameraConnected ? "connected" : "disconnected"),
    createActionItem("$(target) Toggle Goal Mode", COMMAND_SIDEBAR_NAV_TOGGLE_GOAL),
    createActionItem("$(rocket) Toggle Manual Mode", COMMAND_SIDEBAR_NAV_TOGGLE_MANUAL),
    createActionItem("$(swap) Swap Workspace", COMMAND_SIDEBAR_NAV_SWAP),
    createActionItem("$(device-camera) Snapshot Modal", COMMAND_SIDEBAR_NAV_SNAPSHOT),
    createActionItem("$(info) Info Modal", COMMAND_SIDEBAR_NAV_INFO)
  ];
}

function buildTelemetryTreeItems(): vscode.TreeItem[] {
  const snapshot = sidebarSnapshots.telemetry;
  const datumSet = getSnapshotBoolean(snapshot, "datumSet");
  const rtkConnected = getSnapshotBoolean(snapshot, "rtkConnected");
  const yawDeltaDeg = getSnapshotNumber(snapshot, "yawDeltaDeg");
  const recentEvents = getSnapshotNumber(snapshot, "recentEvents") ?? 0;
  const alerts = getSnapshotNumber(snapshot, "alerts") ?? 0;

  return [
    createInfoItem("Datum", datumSet ? "set" : "unset"),
    createInfoItem("RTK Source", rtkConnected ? "connected" : "disconnected"),
    createInfoItem("Yaw delta", yawDeltaDeg === null ? "n/a" : `${yawDeltaDeg.toFixed(2)} deg`),
    createInfoItem("Recent events", String(recentEvents)),
    createInfoItem("Alerts", String(alerts)),
    createActionItem("$(output) Open Cockpit Output", COMMAND_SIDEBAR_TELEMETRY_OUTPUT)
  ];
}

class CockpitSidebarTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly buildItems: () => vscode.TreeItem[]) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    return this.buildItems();
  }
}

function registerWebviewMessageBridge(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  viewDisposables: vscode.Disposable[],
  providers: Record<SidebarSection, CockpitSidebarTreeProvider>
): void {
  viewDisposables.push(
    webview.onDidReceiveMessage(async (payload: unknown) => {
      if (!webviewReady) {
        webviewReady = true;
        flushPendingHostCommands();
      }

      const projection = parseProjectionMessage(payload);
      if (projection) {
        if (projection.slot === "toolbar") {
          toolbarProjection.splice(0, toolbarProjection.length, ...projection.entries);
        }
        if (projection.slot === "footer") {
          applyFooterProjection(projection.entries);
        }
        return;
      }

      const snapshot = parseSidebarSnapshotMessage(payload);
      if (snapshot) {
        sidebarSnapshots[snapshot.section] = { ...snapshot.data };
        providers[snapshot.section].refresh();
        return;
      }

      const consoleEvent = parseConsoleEventMessage(payload);
      if (consoleEvent) {
        appendConsoleEvent(consoleEvent);
        return;
      }

      const request = parseHostRequest(payload);
      if (!request) return;

      try {
        const response = await handleHostRequest(context, request);
        void webview.postMessage(response);
      } catch (error) {
        void webview.postMessage(toHostError(request.id, error));
      }
    })
  );
}

async function configureWebview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  slot: CockpitSlot,
  viewDisposables: vscode.Disposable[],
  providers: Record<SidebarSection, CockpitSidebarTreeProvider>
): Promise<void> {
  const distRoot = vscode.Uri.joinPath(context.extensionUri, "dist");
  webview.options = {
    enableScripts: true,
    localResourceRoots: [distRoot]
  };
  webview.html = await buildWebviewHtml(webview, context.extensionUri, slot);
  registerWebviewMessageBridge(context, webview, viewDisposables, providers);
}

async function ensureMainPanelOpen(
  context: vscode.ExtensionContext,
  providers: Record<SidebarSection, CockpitSidebarTreeProvider>
): Promise<vscode.WebviewPanel> {
  if (workspacePanel) {
    workspacePanel.reveal(vscode.ViewColumn.One, false);
    await setCockpitContext(CONTEXT_MAIN_OPEN, true);
    await setCockpitContext(CONTEXT_MAIN_FOCUSED, true);
    return workspacePanel;
  }

  workspacePanel = vscode.window.createWebviewPanel(
    "cockpit.workspace.panel",
    "Cockpit",
    {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false
    },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")]
    }
  );

  const disposables: vscode.Disposable[] = [];
  webviewReady = false;
  workspacePanel.onDidChangeViewState((event) => {
    void setCockpitContext(CONTEXT_MAIN_OPEN, true);
    void setCockpitContext(CONTEXT_MAIN_FOCUSED, event.webviewPanel.active);
  });
  workspacePanel.onDidDispose(() => {
    workspacePanel = null;
    webviewReady = false;
    pendingHostCommands.splice(0, pendingHostCommands.length);
    disposables.forEach((d) => d.dispose());
    void setCockpitContext(CONTEXT_MAIN_OPEN, false);
    void setCockpitContext(CONTEXT_MAIN_FOCUSED, false);
  });

  await configureWebview(context, workspacePanel.webview, "full", disposables, providers);
  await setCockpitContext(CONTEXT_MAIN_OPEN, true);
  await setCockpitContext(CONTEXT_MAIN_FOCUSED, true);
  return workspacePanel;
}

async function runRuntimeCommand(
  context: vscode.ExtensionContext,
  providers: Record<SidebarSection, CockpitSidebarTreeProvider>,
  commandId: string,
  args: unknown[] = []
): Promise<void> {
  await ensureMainPanelOpen(context, providers);
  forwardHostCommand({
    commandId,
    args
  });
}

function registerSidebarActionCommands(
  context: vscode.ExtensionContext,
  providers: Record<SidebarSection, CockpitSidebarTreeProvider>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_CONNECT, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_CONNECTION_CONNECT);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_DISCONNECT, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_CONNECTION_DISCONNECT);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_PRESET_REAL, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_CONNECTION_SET_PRESET, ["real"]);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_PRESET_SIM, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_CONNECTION_SET_PRESET, ["sim"]);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_SET_HOST, async () => {
      await ensureMainPanelOpen(context, providers);
      const defaultHost = getSnapshotString(sidebarSnapshots.connection, "host", "");
      const nextHost = await vscode.window.showInputBox({
        title: "Cockpit Connection Host",
        prompt: "Ingresa host de conexión",
        value: defaultHost,
        ignoreFocusOut: true
      });
      if (!nextHost || nextHost.trim().length === 0) return;
      forwardHostCommand({
        commandId: RUNTIME_CONNECTION_SET_HOST,
        args: [nextHost.trim()]
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_CONNECTION_SET_PORT, async () => {
      await ensureMainPanelOpen(context, providers);
      const defaultPort = getSnapshotString(sidebarSnapshots.connection, "port", "");
      const nextPort = await vscode.window.showInputBox({
        title: "Cockpit Connection Port",
        prompt: "Ingresa puerto de conexión",
        value: defaultPort,
        ignoreFocusOut: true,
        validateInput: (value) => {
          const parsed = Number(value.trim());
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            return "Port must be integer between 1 and 65535";
          }
          return null;
        }
      });
      if (!nextPort || nextPort.trim().length === 0) return;
      forwardHostCommand({
        commandId: RUNTIME_CONNECTION_SET_PORT,
        args: [nextPort.trim()]
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_NAV_TOGGLE_GOAL, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_NAV_TOGGLE_GOAL);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_NAV_TOGGLE_MANUAL, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_NAV_TOGGLE_MANUAL);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_NAV_SNAPSHOT, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_NAV_OPEN_SNAPSHOT);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_NAV_INFO, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_NAV_OPEN_INFO);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_NAV_SWAP, async () => {
      await runRuntimeCommand(context, providers, RUNTIME_NAV_SWAP);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SIDEBAR_TELEMETRY_OUTPUT, async () => {
      getOutputChannel().show(true);
    })
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await setCockpitContext(CONTEXT_MAIN_OPEN, false);
  await setCockpitContext(CONTEXT_MAIN_FOCUSED, false);

  const sidebarProviders: Record<SidebarSection, CockpitSidebarTreeProvider> = {
    connection: new CockpitSidebarTreeProvider(buildConnectionTreeItems),
    navigation: new CockpitSidebarTreeProvider(buildNavigationTreeItems),
    telemetry: new CockpitSidebarTreeProvider(buildTelemetryTreeItems)
  };

  registerSidebarActionCommands(context, sidebarProviders);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN, async () => {
      await ensureMainPanelOpen(context, sidebarProviders);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_WORKSPACE_OPEN, async (workspaceId?: unknown) => {
      await ensureMainPanelOpen(context, sidebarProviders);
      if (typeof workspaceId === "string" && workspaceId.trim().length > 0) {
        forwardHostCommand({
          activateWorkspaceId: workspaceId.trim()
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_MODAL_OPEN, async (modalId?: unknown) => {
      await ensureMainPanelOpen(context, sidebarProviders);
      if (typeof modalId === "string" && modalId.trim().length > 0) {
        forwardHostCommand({
          openModalId: modalId.trim()
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_TOOLBAR_SHOW, async () => {
      await ensureMainPanelOpen(context, sidebarProviders);
      await showToolbarPicker();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_TERMINAL_TOGGLE, async () => {
      await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_TERMINAL_NEW, async () => {
      const terminal = vscode.window.createTerminal({ name: "Cockpit" });
      activeTerminal = terminal;
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_FOCUS_SIDEBAR_CONTAINER, async () => {
      await vscode.commands.executeCommand("workbench.view.extension.cockpit");
      await ensureMainPanelOpen(context, sidebarProviders);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_FOCUS_CONSOLE_CONTAINER, async () => {
      getOutputChannel().show(true);
    })
  );

  const connectionTreeView = vscode.window.createTreeView(VIEW_ID_SIDEBAR_CONNECTION, {
    treeDataProvider: sidebarProviders.connection
  });
  const navigationTreeView = vscode.window.createTreeView(VIEW_ID_SIDEBAR_NAVIGATION, {
    treeDataProvider: sidebarProviders.navigation
  });
  const telemetryTreeView = vscode.window.createTreeView(VIEW_ID_SIDEBAR_TELEMETRY, {
    treeDataProvider: sidebarProviders.telemetry
  });

  const maybeOpenMainPanelFromSidebar = (visible: boolean): void => {
    if (!visible || sidebarAutoOpened) return;
    sidebarAutoOpened = true;
    void ensureMainPanelOpen(context, sidebarProviders);
  };

  connectionTreeView.onDidChangeVisibility((event) => maybeOpenMainPanelFromSidebar(event.visible));
  navigationTreeView.onDidChangeVisibility((event) => maybeOpenMainPanelFromSidebar(event.visible));
  telemetryTreeView.onDidChangeVisibility((event) => maybeOpenMainPanelFromSidebar(event.visible));

  context.subscriptions.push(connectionTreeView, navigationTreeView, telemetryTreeView);
}

export function deactivate(): void {
  for (const item of footerStatusBarById.values()) {
    item.dispose();
  }
  footerStatusBarById.clear();
  if (cockpitOutputChannel) {
    cockpitOutputChannel.dispose();
    cockpitOutputChannel = null;
  }
}

export type HostRpcMethod =
  | "host.config.read"
  | "host.config.write"
  | "host.config.remove"
  | "host.notify"
  | "host.dialog.alert"
  | "host.dialog.confirm"
  | "host.dialog.prompt"
  | "host.focus.isFocused"
  | "host.terminal.open"
  | "host.terminal.sendText"
  | "host.terminal.reveal";

interface VsCodeApiLike {
  postMessage(message: unknown): void;
}

interface HostRequestMessage {
  type: "host.request";
  id: string;
  method: HostRpcMethod;
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

type SidebarSnapshotSection = "connection" | "navigation" | "telemetry";

interface SidebarSnapshotMessage {
  type: "cockpit.sidebar.snapshot";
  section: SidebarSnapshotSection;
  data: Record<string, unknown>;
}

interface ConsoleEventMessage {
  type: "cockpit.console.event";
  level: string;
  text: string;
  timestamp: number;
  source?: string;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApiLike;
  }
}

const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

let installed = false;
let nextRequestId = 1;
let vscodeApi: VsCodeApiLike | null = null;

function getVsCodeApi(): VsCodeApiLike | null {
  if (vscodeApi) return vscodeApi;
  if (typeof window === "undefined" || typeof window.acquireVsCodeApi !== "function") {
    return null;
  }
  vscodeApi = window.acquireVsCodeApi();
  return vscodeApi;
}

function installHostResponseListener(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<HostResponseMessage> | null;
    if (!data || data.type !== "host.response" || typeof data.id !== "string") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
      return;
    }
    entry.reject(new Error(typeof data.error === "string" ? data.error : "Host request failed"));
  });
}

export function isHostBridgeAvailable(): boolean {
  return getVsCodeApi() !== null;
}

export async function hostRequest<TResult = unknown>(
  method: HostRpcMethod,
  params?: Record<string, unknown>
): Promise<TResult | undefined> {
  const api = getVsCodeApi();
  if (!api) return undefined;

  installHostResponseListener();

  const id = `req-${nextRequestId++}`;
  const request: HostRequestMessage = {
    type: "host.request",
    id,
    method,
    params
  };

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  api.postMessage(request);

  return (await resultPromise) as TResult;
}

export function emitProjection(
  slot: "toolbar" | "footer",
  entries: Array<Record<string, unknown>>
): void {
  const api = getVsCodeApi();
  if (!api) return;
  const message: ProjectionMessage = {
    type: "cockpit.projection",
    slot,
    entries
  };
  api.postMessage(message);
}

export function emitSidebarSnapshot(section: SidebarSnapshotSection, data: Record<string, unknown>): void {
  const api = getVsCodeApi();
  if (!api) return;
  const message: SidebarSnapshotMessage = {
    type: "cockpit.sidebar.snapshot",
    section,
    data
  };
  api.postMessage(message);
}

export function emitConsoleEvent(event: { level: string; text: string; timestamp: number; source?: string }): void {
  const api = getVsCodeApi();
  if (!api) return;
  const message: ConsoleEventMessage = {
    type: "cockpit.console.event",
    level: event.level,
    text: event.text,
    timestamp: event.timestamp,
    source: event.source
  };
  api.postMessage(message);
}

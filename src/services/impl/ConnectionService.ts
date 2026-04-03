import type { EnvConfig } from "../../core/config/envConfig";
import type { EventBus } from "../../core/events/eventBus";
import type { TransportManager } from "../../transport/manager/TransportManager";

export type ConnectionPreset = "real" | "sim";

export interface ConnectionState {
  preset: ConnectionPreset;
  host: string;
  port: string;
  connecting: boolean;
  connected: boolean;
  lastError: string;
}

type ConnectionListener = (state: ConnectionState) => void;

const PRESET_DEFAULTS: Record<ConnectionPreset, { host: string; port: string }> = {
  real: { host: "127.0.0.1", port: "8766" },
  sim: { host: "localhost", port: "8766" }
};

function parseWsUrl(url: string): { host: string; port: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || PRESET_DEFAULTS.real.host,
      port: parsed.port || PRESET_DEFAULTS.real.port
    };
  } catch {
    return PRESET_DEFAULTS.real;
  }
}

export class ConnectionService {
  private readonly listeners = new Set<ConnectionListener>();
  private state: ConnectionState;

  constructor(
    private readonly transportManager: TransportManager,
    private readonly env: EnvConfig,
    private readonly transportId: string,
    private readonly eventBus: EventBus
  ) {
    const parsed = parseWsUrl(env.wsUrl);
    this.state = {
      preset: "real",
      host: parsed.host,
      port: parsed.port,
      connecting: false,
      connected: false,
      lastError: ""
    };
  }

  getState(): ConnectionState {
    return { ...this.state };
  }

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPreset(preset: ConnectionPreset): void {
    const defaults = PRESET_DEFAULTS[preset];
    this.state = {
      ...this.state,
      preset,
      host: defaults.host,
      port: defaults.port,
      lastError: ""
    };
    this.emit();
  }

  setHost(host: string): void {
    this.state = {
      ...this.state,
      host,
      lastError: ""
    };
    this.emit();
  }

  setPort(port: string): void {
    this.state = {
      ...this.state,
      port,
      lastError: ""
    };
    this.emit();
  }

  async connect(): Promise<void> {
    this.state = {
      ...this.state,
      connecting: true,
      lastError: ""
    };
    this.emit();

    try {
      const host = this.state.host.trim();
      const port = this.state.port.trim();
      if (!host) {
        throw new Error("Host is required");
      }
      if (!port || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
        throw new Error("Port must be an integer between 1 and 65535");
      }

      this.env.wsUrl = `ws://${host}:${port}`;
      await this.transportManager.disconnectTransport(this.transportId);
      await this.transportManager.connectTransport(this.transportId, { env: this.env });
      this.state = {
        ...this.state,
        connecting: false,
        connected: true,
        lastError: ""
      };
      this.eventBus.emit("console.event", {
        level: "info",
        text: `Connected to ${this.env.wsUrl}`,
        timestamp: Date.now()
      });
      this.emit();
    } catch (error) {
      this.state = {
        ...this.state,
        connecting: false,
        connected: false,
        lastError: String(error)
      };
      this.eventBus.emit("console.event", {
        level: "error",
        text: `Connection error: ${String(error)}`,
        timestamp: Date.now()
      });
      this.emit();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.transportManager.disconnectTransport(this.transportId);
      this.state = {
        ...this.state,
        connecting: false,
        connected: false,
        lastError: ""
      };
      this.eventBus.emit("console.event", {
        level: "info",
        text: "Disconnected",
        timestamp: Date.now()
      });
      this.emit();
    } catch (error) {
      this.state = {
        ...this.state,
        connecting: false,
        connected: false,
        lastError: String(error)
      };
      this.emit();
      throw error;
    }
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}


import type { EnvConfig } from "../../../../../../core/config/envConfig";
import type { EventBus } from "../../../../../../core/events/eventBus";
import type { TransportStatus } from "../../../../../core/modules/runtime/transport/base/Transport";
import type { TransportManager, TransportTrafficStats } from "../../../../../core/modules/runtime/transport/manager/TransportManager";

export type ConnectionPreset = "real" | "sim";

export interface ConnectionState {
  preset: ConnectionPreset;
  host: string;
  port: string;
  connecting: boolean;
  connected: boolean;
  lastError: string;
  txBytes: number;
  rxBytes: number;
}

type ConnectionListener = (state: ConnectionState) => void;

const CONNECTION_PRESET_STORAGE_KEY = "map_tools.connection_presets.v2";

export interface ConnectionPresetDefaults {
  real: { host: string; port: string };
  sim: { host: string; port: string };
}

function getStorageAdapter(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  if (
    typeof window !== "undefined" &&
    window.localStorage &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function"
  ) {
    return window.localStorage;
  }
  return {
    getItem: () => null,
    setItem: () => undefined
  };
}

function parseWsUrl(url: string, fallbackHost: string, fallbackPort: string): { host: string; port: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || fallbackHost,
      port: parsed.port || fallbackPort
    };
  } catch {
    return { host: fallbackHost, port: fallbackPort };
  }
}

export class ConnectionService {
  private readonly listeners = new Set<ConnectionListener>();
  private presetValues: Record<ConnectionPreset, { host: string; port: string }>;
  private initialPreset: ConnectionPreset = "real";
  private state: ConnectionState;

  constructor(
    private readonly transportManager: TransportManager,
    private readonly env: EnvConfig,
    private readonly transportId: string,
    private readonly eventBus: EventBus,
    presetDefaults?: ConnectionPresetDefaults
  ) {
    const wsRealHost = env.wsRealHost ?? "localhost";
    const wsSimHost = env.wsSimHost ?? "localhost";
    const wsDefaultPort = env.wsDefaultPort ?? "8766";
    const parsed = parseWsUrl(env.wsUrl, wsRealHost, wsDefaultPort);
    const realHost = wsRealHost || parsed.host;
    const realPort = wsDefaultPort || parsed.port;
    const defaults: Record<ConnectionPreset, { host: string; port: string }> = {
      real: {
        host: realHost,
        port: realPort
      },
      sim: {
        host: wsSimHost,
        port: wsDefaultPort
      }
    };
    const mergedDefaults: Record<ConnectionPreset, { host: string; port: string }> = {
      real: {
        host: String(presetDefaults?.real?.host ?? defaults.real.host),
        port: String(presetDefaults?.real?.port ?? defaults.real.port)
      },
      sim: {
        host: String(presetDefaults?.sim?.host ?? defaults.sim.host),
        port: String(presetDefaults?.sim?.port ?? defaults.sim.port)
      }
    };
    this.presetValues = this.readPresetStorage(mergedDefaults);
    this.initialPreset = this.readStoredPreset();
    const initialTraffic = this.transportManager.getTrafficStats(this.transportId);
    this.state = {
      preset: this.initialPreset,
      host: this.presetValues[this.initialPreset].host,
      port: this.presetValues[this.initialPreset].port,
      connecting: false,
      connected: false,
      lastError: "",
      txBytes: initialTraffic.txBytes,
      rxBytes: initialTraffic.rxBytes
    };
    this.transportManager.subscribeTraffic(this.transportId, (stats) => {
      this.applyTraffic(stats);
    });
    this.transportManager.subscribeStatus(this.transportId, (status) => {
      this.applyTransportStatus(status);
    });
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
    this.presetValues[this.state.preset] = {
      host: this.state.host,
      port: this.state.port
    };
    const defaults = this.presetValues[preset];
    this.state = {
      ...this.state,
      preset,
      host: defaults.host,
      port: defaults.port,
      lastError: ""
    };
    this.persistPresetStorage();
    this.emit();
  }

  setHost(host: string): void {
    this.presetValues[this.state.preset] = {
      ...this.presetValues[this.state.preset],
      host
    };
    this.state = {
      ...this.state,
      host,
      lastError: ""
    };
    this.persistPresetStorage();
    this.emit();
  }

  setPort(port: string): void {
    this.presetValues[this.state.preset] = {
      ...this.presetValues[this.state.preset],
      port
    };
    this.state = {
      ...this.state,
      port,
      lastError: ""
    };
    this.persistPresetStorage();
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

  isCameraEnabled(): boolean {
    return this.state.preset !== "sim" && this.env.cameraIframeUrl.trim().length > 0;
  }

  getCameraIframeUrl(): string {
    return this.isCameraEnabled() ? this.env.cameraIframeUrl.trim() : "";
  }

  applyPresetDefaults(defaults: ConnectionPresetDefaults): void {
    const nextPresets: Record<ConnectionPreset, { host: string; port: string }> = {
      real: {
        host: String(defaults.real.host ?? this.presetValues.real.host),
        port: String(defaults.real.port ?? this.presetValues.real.port)
      },
      sim: {
        host: String(defaults.sim.host ?? this.presetValues.sim.host),
        port: String(defaults.sim.port ?? this.presetValues.sim.port)
      }
    };
    this.presetValues = nextPresets;
    const activePreset = this.state.preset;
    this.state = {
      ...this.state,
      host: nextPresets[activePreset].host,
      port: nextPresets[activePreset].port
    };
    this.persistPresetStorage();
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private applyTraffic(stats: TransportTrafficStats): void {
    if (this.state.txBytes === stats.txBytes && this.state.rxBytes === stats.rxBytes) return;
    this.state = {
      ...this.state,
      txBytes: stats.txBytes,
      rxBytes: stats.rxBytes
    };
    this.emit();
  }

  private applyTransportStatus(status: TransportStatus): void {
    if (status.connected) {
      if (this.state.connected && !this.state.connecting && !this.state.lastError) return;
      this.state = {
        ...this.state,
        connecting: false,
        connected: true,
        lastError: ""
      };
      this.emit();
      return;
    }

    const reason = String(status.reason ?? "").trim();
    const nextError = status.intentional ? "" : reason || "Conexión perdida con backend";
    const changed =
      this.state.connecting ||
      this.state.connected ||
      this.state.lastError !== nextError;
    if (!changed) return;

    this.state = {
      ...this.state,
      connecting: false,
      connected: false,
      lastError: nextError
    };
    if (!status.intentional) {
      this.eventBus.emit("console.event", {
        level: "error",
        text: nextError,
        timestamp: Date.now()
      });
    }
    this.emit();
  }

  private readPresetStorage(defaults: Record<ConnectionPreset, { host: string; port: string }>): Record<ConnectionPreset, { host: string; port: string }> {
    const raw = getStorageAdapter().getItem(CONNECTION_PRESET_STORAGE_KEY);
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw) as {
        presets?: Record<string, { host?: string; port?: string }>;
      };
      const presets = parsed.presets ?? {};
      return {
        real: {
          host: String(presets.real?.host ?? defaults.real.host),
          port: String(presets.real?.port ?? defaults.real.port)
        },
        sim: {
          host: String(presets.sim?.host ?? defaults.sim.host),
          port: String(presets.sim?.port ?? defaults.sim.port)
        }
      };
    } catch {
      return defaults;
    }
  }

  private persistPresetStorage(): void {
    getStorageAdapter().setItem(
      CONNECTION_PRESET_STORAGE_KEY,
      JSON.stringify({
        preset: this.state.preset,
        presets: this.presetValues
      })
    );
  }

  private readStoredPreset(): ConnectionPreset {
    const raw = getStorageAdapter().getItem(CONNECTION_PRESET_STORAGE_KEY);
    if (!raw) return "real";
    try {
      const parsed = JSON.parse(raw) as { preset?: string };
      return parsed.preset === "sim" ? "sim" : "real";
    } catch {
      return "real";
    }
  }
}

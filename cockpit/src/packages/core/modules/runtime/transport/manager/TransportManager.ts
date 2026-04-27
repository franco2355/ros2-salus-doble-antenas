import type { Transport, TransportContext, TransportStatus } from "../base/Transport";

export interface TransportTrafficStats {
  txBytes: number;
  rxBytes: number;
}

type TrafficListener = (stats: TransportTrafficStats) => void;
type StatusListener = (status: TransportStatus) => void;

function estimateBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value ?? {});
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(json).length;
    }
    return json.length;
  } catch {
    return 0;
  }
}

export class TransportManager {
  private readonly transports = new Map<string, Transport>();
  private readonly trafficByTransport = new Map<string, TransportTrafficStats>();
  private readonly trafficListeners = new Map<string, Set<TrafficListener>>();
  private readonly statusListeners = new Map<string, Set<StatusListener>>();
  private readonly statusBindings = new Map<string, () => void>();

  registerTransport(transport: Transport): void {
    if (this.transports.has(transport.id)) {
      throw new Error(`Transport collision: '${transport.id}' already exists`);
    }
    this.transports.set(transport.id, transport);
    this.trafficByTransport.set(transport.id, { txBytes: 0, rxBytes: 0 });
    this.bindStatus(transport);
  }

  unregisterTransport(transportId: string): void {
    this.statusBindings.get(transportId)?.();
    this.statusBindings.delete(transportId);
    this.transports.delete(transportId);
    this.trafficByTransport.delete(transportId);
    this.trafficListeners.delete(transportId);
    this.statusListeners.delete(transportId);
  }

  getTransport(transportId: string): Transport | undefined {
    return this.transports.get(transportId);
  }

  listTransports(): Transport[] {
    return [...this.transports.values()];
  }

  async connectAll(ctx: TransportContext): Promise<void> {
    const tasks = this.listTransports().map(async (transport) => {
      await transport.connect(ctx);
    });
    await Promise.allSettled(tasks);
  }

  async connectTransport(transportId: string, ctx: TransportContext): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    this.resetTraffic(transportId);
    await transport.connect(ctx);
  }

  async disconnectAll(): Promise<void> {
    const tasks = this.listTransports().map(async (transport) => {
      await transport.disconnect();
    });
    await Promise.allSettled(tasks);
  }

  async disconnectTransport(transportId: string): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    await transport.disconnect();
  }

  async send(transportId: string, packet: unknown): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    await transport.send(packet);
    this.bumpTraffic(transportId, "txBytes", estimateBytes(packet));
  }

  recv(transportId: string, handler: (message: unknown) => void): () => void {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    return transport.recv((message) => {
      this.bumpTraffic(transportId, "rxBytes", estimateBytes(message));
      handler(message);
    });
  }

  getTrafficStats(transportId: string): TransportTrafficStats {
    const stats = this.trafficByTransport.get(transportId) ?? { txBytes: 0, rxBytes: 0 };
    return { ...stats };
  }

  subscribeTraffic(transportId: string, listener: TrafficListener): () => void {
    const listeners = this.trafficListeners.get(transportId) ?? new Set<TrafficListener>();
    listeners.add(listener);
    this.trafficListeners.set(transportId, listeners);
    listener(this.getTrafficStats(transportId));
    return () => {
      const set = this.trafficListeners.get(transportId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.trafficListeners.delete(transportId);
      }
    };
  }

  subscribeStatus(transportId: string, listener: StatusListener): () => void {
    const listeners = this.statusListeners.get(transportId) ?? new Set<StatusListener>();
    listeners.add(listener);
    this.statusListeners.set(transportId, listeners);
    const transport = this.transports.get(transportId);
    if (transport) {
      this.bindStatus(transport);
    }

    return () => {
      const set = this.statusListeners.get(transportId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.statusListeners.delete(transportId);
      }
    };
  }

  private bindStatus(transport: Transport): void {
    if (this.statusBindings.has(transport.id)) return;
    const unsubscribe = transport.subscribeStatus((status) => {
      const listeners = this.statusListeners.get(transport.id);
      if (!listeners || listeners.size === 0) return;
      listeners.forEach((listener) => listener(status));
    });
    this.statusBindings.set(transport.id, unsubscribe);
  }

  private resetTraffic(transportId: string): void {
    this.trafficByTransport.set(transportId, { txBytes: 0, rxBytes: 0 });
    this.emitTraffic(transportId);
  }

  private bumpTraffic(transportId: string, key: keyof TransportTrafficStats, bytes: number): void {
    const amount = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
    const current = this.trafficByTransport.get(transportId) ?? { txBytes: 0, rxBytes: 0 };
    this.trafficByTransport.set(transportId, {
      ...current,
      [key]: current[key] + amount
    });
    this.emitTraffic(transportId);
  }

  private emitTraffic(transportId: string): void {
    const listeners = this.trafficListeners.get(transportId);
    if (!listeners || listeners.size === 0) return;
    const snapshot = this.getTrafficStats(transportId);
    listeners.forEach((listener) => listener(snapshot));
  }
}

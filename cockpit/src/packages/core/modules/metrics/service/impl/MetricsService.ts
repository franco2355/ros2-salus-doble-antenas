import type { TransportManager, TransportTrafficStats } from "../../../runtime/transport/manager/TransportManager";

export const METRICS_SERVICE_ID = "service.metrics";

export interface MetricsState {
  txBytes: number;
  rxBytes: number;
  totalBytes: number;
}

type MetricsStateListener = (state: MetricsState) => void;

export class MetricsService {
  private readonly listeners = new Set<MetricsStateListener>();
  private readonly statsByTransport = new Map<string, TransportTrafficStats>();
  private readonly unsubscribers: Array<() => void> = [];
  private initialized = false;
  private state: MetricsState = {
    txBytes: 0,
    rxBytes: 0,
    totalBytes: 0
  };

  constructor(private readonly transportManager: TransportManager) {}

  getState(): MetricsState {
    this.ensureInitialized();
    return { ...this.state };
  }

  subscribe(listener: MetricsStateListener): () => void {
    this.ensureInitialized();
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.statsByTransport.clear();
    this.initialized = false;
    this.state = {
      txBytes: 0,
      rxBytes: 0,
      totalBytes: 0
    };
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    const transports = this.transportManager.listTransports();
    transports.forEach((transport) => {
      const transportId = transport.id;
      this.statsByTransport.set(transportId, this.transportManager.getTrafficStats(transportId));
      const unsubscribe = this.transportManager.subscribeTraffic(transportId, (stats) => {
        this.statsByTransport.set(transportId, { ...stats });
        this.recalculateAndEmit();
      });
      this.unsubscribers.push(unsubscribe);
    });
    this.recalculateAndEmit();
  }

  private recalculateAndEmit(): void {
    let txBytes = 0;
    let rxBytes = 0;
    this.statsByTransport.forEach((stats) => {
      txBytes += Number.isFinite(stats.txBytes) ? Math.max(0, Math.floor(stats.txBytes)) : 0;
      rxBytes += Number.isFinite(stats.rxBytes) ? Math.max(0, Math.floor(stats.rxBytes)) : 0;
    });
    const nextState: MetricsState = {
      txBytes,
      rxBytes,
      totalBytes: txBytes + rxBytes
    };
    if (
      nextState.txBytes === this.state.txBytes &&
      nextState.rxBytes === this.state.rxBytes &&
      nextState.totalBytes === this.state.totalBytes
    ) {
      return;
    }
    this.state = nextState;
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

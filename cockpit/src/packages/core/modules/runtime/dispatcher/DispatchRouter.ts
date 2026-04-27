import type { Dispatcher } from "./base/Dispatcher";
import type { TransportManager } from "../transport/manager/TransportManager";

export class DispatchRouter {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private readonly byTransport = new Map<string, Set<Dispatcher>>();
  private readonly transportBindings = new Map<string, () => void>();

  constructor(private readonly transportManager: TransportManager) {}

  bindTransport(transportId: string): void {
    if (this.transportBindings.has(transportId)) return;
    const transport = this.transportManager.getTransport(transportId);
    if (!transport) return;

    const unsubscribe = this.transportManager.recv(transportId, (raw) => {
      this.handleIncoming(transportId, raw);
    });
    this.transportBindings.set(transportId, unsubscribe);
  }

  registerDispatcher(dispatcher: Dispatcher): void {
    if (this.dispatchers.has(dispatcher.id)) {
      throw new Error(`Dispatcher collision: '${dispatcher.id}' already exists`);
    }
    this.dispatchers.set(dispatcher.id, dispatcher);
    dispatcher.setRouter(this);
    const bucket = this.byTransport.get(dispatcher.transportId) ?? new Set<Dispatcher>();
    bucket.add(dispatcher);
    this.byTransport.set(dispatcher.transportId, bucket);
  }

  async sendRaw(transportId: string, raw: unknown): Promise<void> {
    await this.transportManager.send(transportId, raw);
  }

  private handleIncoming(transportId: string, raw: unknown): void {
    const targets = this.byTransport.get(transportId);
    if (!targets || targets.size === 0) return;
    targets.forEach((dispatcher) => {
      dispatcher.handleIncoming(raw, transportId);
    });
  }
}

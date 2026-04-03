import type { IncomingPacket, MessagePayload } from "../core/types/message";
import type { Dispatcher, RequestOptions } from "./base/Dispatcher";
import type { TransportManager } from "../transport/manager/TransportManager";

interface PendingRequest {
  resolve: (message: IncomingPacket) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class DispatchRouter {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private readonly byOp = new Map<string, Set<Dispatcher>>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly transportBindings = new Map<string, () => void>();
  private requestSequence = 0;

  constructor(private readonly transportManager: TransportManager) {}

  bindTransport(transportId: string): void {
    if (this.transportBindings.has(transportId)) return;
    const transport = this.transportManager.getTransport(transportId);
    if (!transport) return;

    const unsubscribe = transport.recv((message) => {
      this.handleIncoming(transportId, message);
    });
    this.transportBindings.set(transportId, unsubscribe);
  }

  registerDispatcher(dispatcher: Dispatcher): void {
    if (this.dispatchers.has(dispatcher.id)) {
      throw new Error(`Dispatcher collision: '${dispatcher.id}' already exists`);
    }
    this.dispatchers.set(dispatcher.id, dispatcher);
    dispatcher.setRouter(this);

    dispatcher.ops.forEach((op) => {
      const set = this.byOp.get(op) ?? new Set<Dispatcher>();
      set.add(dispatcher);
      this.byOp.set(op, set);
    });
  }

  async request(
    transportId: string,
    op: string,
    payload?: MessagePayload,
    options?: RequestOptions
  ): Promise<IncomingPacket> {
    const timeoutMs = options?.timeoutMs ?? 4000;
    const requestId = this.nextRequestId(op);

    return new Promise<IncomingPacket>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request timeout for op '${op}'`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeoutHandle });

      void this.transportManager
        .send(transportId, { op, requestId, payload })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          this.pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private handleIncoming(transportId: string, message: IncomingPacket): void {
    const inbound: IncomingPacket = { ...message, transportId };
    if (inbound.requestId && this.pending.has(inbound.requestId)) {
      const pending = this.pending.get(inbound.requestId)!;
      clearTimeout(pending.timeoutHandle);
      this.pending.delete(inbound.requestId);
      pending.resolve(inbound);
    }

    const direct = this.byOp.get(inbound.op) ?? new Set<Dispatcher>();
    const wildcard = this.byOp.get("*") ?? new Set<Dispatcher>();
    const targets = new Set<Dispatcher>([...direct, ...wildcard]);

    targets.forEach((dispatcher) => {
      if (dispatcher.transportId === transportId) {
        dispatcher.handleIncoming(inbound);
      }
    });
  }

  private nextRequestId(op: string): string {
    this.requestSequence += 1;
    return `${op}.${Date.now()}.${this.requestSequence}`;
  }
}


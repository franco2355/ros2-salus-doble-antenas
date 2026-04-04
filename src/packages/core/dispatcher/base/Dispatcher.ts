import type { IncomingPacket, MessagePayload } from "../../../../core/types/message";
import type { DispatchRouter } from "../DispatchRouter";

export interface RequestOptions {
  timeoutMs?: number;
}

export interface Dispatcher {
  id: string;
  transportId: string;
  ops: string[];
  setRouter(router: DispatchRouter): void;
  handleIncoming(message: IncomingPacket): void;
  request(op: string, payload?: MessagePayload, options?: RequestOptions): Promise<IncomingPacket>;
  subscribe(op: string, callback: (message: IncomingPacket) => void): () => void;
}

export abstract class DispatcherBase implements Dispatcher {
  private router: DispatchRouter | null = null;
  private readonly subscribers = new Map<string, Set<(message: IncomingPacket) => void>>();

  constructor(
    readonly id: string,
    readonly transportId: string,
    readonly ops: string[]
  ) {}

  setRouter(router: DispatchRouter): void {
    this.router = router;
  }

  async request(op: string, payload?: MessagePayload, options?: RequestOptions): Promise<IncomingPacket> {
    if (!this.router) {
      throw new Error(`Dispatcher '${this.id}' is not attached to a router`);
    }
    return this.router.request(this.transportId, op, payload, options);
  }

  subscribe(op: string, callback: (message: IncomingPacket) => void): () => void {
    const set = this.subscribers.get(op) ?? new Set<(message: IncomingPacket) => void>();
    set.add(callback);
    this.subscribers.set(op, set);
    return () => {
      const current = this.subscribers.get(op);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.subscribers.delete(op);
      }
    };
  }

  protected publish(op: string, message: IncomingPacket): void {
    const direct = this.subscribers.get(op);
    if (direct) {
      direct.forEach((handler) => handler(message));
    }
    const wildcard = this.subscribers.get("*");
    if (wildcard) {
      wildcard.forEach((handler) => handler(message));
    }
  }

  abstract handleIncoming(message: IncomingPacket): void;
}


import type { IncomingPacket, MessagePayload } from "../../../../../core/types/message";
import type { Dispatcher, RequestOptions } from "./base/Dispatcher";
import type { TransportManager } from "../transport/manager/TransportManager";

interface PendingRequest {
  requestId: string;
  request: string;
  resolve: (message: IncomingPacket) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class DispatchRouter {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private readonly byOp = new Map<string, Set<Dispatcher>>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingByRequest = new Map<string, string[]>();
  private readonly transportBindings = new Map<string, () => void>();
  private requestSequence = 0;

  constructor(private readonly transportManager: TransportManager) {}

  bindTransport(transportId: string): void {
    if (this.transportBindings.has(transportId)) return;
    const transport = this.transportManager.getTransport(transportId);
    if (!transport) return;

    const unsubscribe = this.transportManager.recv(transportId, (message) => {
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
        this.removePending(requestId);
        reject(new Error(`Request timeout for op '${op}'`));
      }, timeoutMs);

      const pending: PendingRequest = { requestId, request: op, resolve, reject, timeoutHandle };
      this.pending.set(requestId, pending);
      const queue = this.pendingByRequest.get(op) ?? [];
      queue.push(requestId);
      this.pendingByRequest.set(op, queue);

      void this.transportManager
        .send(transportId, {
          op,
          requestId,
          clientReqId: requestId,
          payload
        })
        .catch((error) => {
          this.removePending(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private handleIncoming(transportId: string, message: IncomingPacket): void {
    const inbound: IncomingPacket = {
      ...message,
      transportId,
      requestId: String(message.requestId ?? message.clientReqId ?? message.client_req_id ?? "")
        || undefined,
      clientReqId: String(message.clientReqId ?? message.client_req_id ?? message.requestId ?? "")
        || undefined
    };

    const correlatedPending = this.resolvePendingByMessage(inbound);
    if (correlatedPending) {
      correlatedPending.resolve(inbound);
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

  private resolvePendingByMessage(message: IncomingPacket): PendingRequest | null {
    const directId = message.requestId ?? message.clientReqId;
    if (directId && this.pending.has(directId)) {
      return this.removePending(directId);
    }

    const requestName = typeof message.request === "string" ? message.request : "";
    if (!requestName) return null;
    const queue = this.pendingByRequest.get(requestName);
    if (!queue || queue.length === 0) return null;

    while (queue.length > 0) {
      const requestId = queue.shift()!;
      if (!this.pending.has(requestId)) continue;
      if (queue.length === 0) {
        this.pendingByRequest.delete(requestName);
      } else {
        this.pendingByRequest.set(requestName, queue);
      }
      return this.removePending(requestId);
    }
    this.pendingByRequest.delete(requestName);
    return null;
  }

  private removePending(requestId: string): PendingRequest | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(requestId);
    const queue = this.pendingByRequest.get(pending.request);
    if (queue) {
      const filtered = queue.filter((entry) => entry !== requestId);
      if (filtered.length === 0) {
        this.pendingByRequest.delete(pending.request);
      } else {
        this.pendingByRequest.set(pending.request, filtered);
      }
    }
    return pending;
  }

  private nextRequestId(op: string): string {
    this.requestSequence += 1;
    return `${op}.${Date.now()}.${this.requestSequence}`;
  }
}

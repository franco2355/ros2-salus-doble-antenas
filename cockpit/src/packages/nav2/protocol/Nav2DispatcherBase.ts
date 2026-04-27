import { DispatcherBase, type RequestOptions } from "../../core/modules/runtime/dispatcher/base/Dispatcher";
import { decodeNav2Incoming, encodeNav2Outgoing, type Nav2IncomingMessage } from "./messages";

interface PendingRequest {
  request: string;
  resolve: (message: Nav2IncomingMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export abstract class Nav2DispatcherBase extends DispatcherBase {
  private readonly subscribers = new Map<string, Set<(message: Nav2IncomingMessage) => void>>();
  private readonly pendingByRequestId = new Map<string, PendingRequest>();
  private readonly pendingIdsByRequest = new Map<string, string[]>();
  private sequence = 0;

  subscribe(op: string, callback: (message: Nav2IncomingMessage) => void): () => void {
    const listeners = this.subscribers.get(op) ?? new Set<(message: Nav2IncomingMessage) => void>();
    listeners.add(callback);
    this.subscribers.set(op, listeners);
    return () => {
      const current = this.subscribers.get(op);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.subscribers.delete(op);
      }
    };
  }

  protected async request(op: string, payload?: unknown, options?: RequestOptions): Promise<Nav2IncomingMessage> {
    const requestId = this.nextRequestId(op);
    const timeoutMs = options?.timeoutMs ?? 4000;

    return new Promise<Nav2IncomingMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.releasePending(requestId);
        reject(new Error(`Request timeout for op '${op}'`));
      }, timeoutMs);

      this.pendingByRequestId.set(requestId, { request: op, resolve, reject, timeout });
      const pendingIds = this.pendingIdsByRequest.get(op) ?? [];
      pendingIds.push(requestId);
      this.pendingIdsByRequest.set(op, pendingIds);

      void this.sendRaw(
        encodeNav2Outgoing({
          op,
          requestId,
          payload
        })
      ).catch((error) => {
        this.resolvePendingWithError(
          requestId,
          error instanceof Error ? error : new Error(String(error))
        );
      });
    });
  }

  handleIncoming(raw: unknown, transportId: string): void {
    const decoded = decodeNav2Incoming(raw);
    if (!decoded) return;
    const message = decoded.transportId ? decoded : { ...decoded, transportId };

    const requestId = this.resolvePendingRequestId(message);
    if (requestId) {
      const pending = this.releasePending(requestId);
      if (pending) {
        pending.resolve(message);
      }
    }

    this.publish(message.op, message);
    this.onMessage(message);
  }

  protected onMessage(_message: Nav2IncomingMessage): void {}

  protected publish(op: string, message: Nav2IncomingMessage): void {
    const direct = this.subscribers.get(op);
    if (direct) {
      direct.forEach((listener) => listener(message));
    }
    const wildcard = this.subscribers.get("*");
    if (wildcard) {
      wildcard.forEach((listener) => listener(message));
    }
  }

  private resolvePendingWithError(requestId: string, error: Error): void {
    const pending = this.releasePending(requestId);
    if (!pending) return;
    pending.reject(error);
  }

  private resolvePendingRequestId(message: Nav2IncomingMessage): string | null {
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : "";
    if (requestId && this.pendingByRequestId.has(requestId)) {
      return requestId;
    }

    if (message.op !== "ack") return null;
    const request = typeof message.request === "string" ? message.request.trim() : "";
    if (!request) return null;
    const pendingIds = this.pendingIdsByRequest.get(request) ?? [];
    return pendingIds[0] ?? null;
  }

  private releasePending(requestId: string): PendingRequest | undefined {
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending) return undefined;

    clearTimeout(pending.timeout);
    this.pendingByRequestId.delete(requestId);

    const pendingIds = this.pendingIdsByRequest.get(pending.request) ?? [];
    const nextPendingIds = pendingIds.filter((id) => id !== requestId);
    if (nextPendingIds.length > 0) {
      this.pendingIdsByRequest.set(pending.request, nextPendingIds);
    } else {
      this.pendingIdsByRequest.delete(pending.request);
    }

    return pending;
  }

  private nextRequestId(op: string): string {
    this.sequence += 1;
    return `${this.id}.${op}.${Date.now()}.${this.sequence}`;
  }
}

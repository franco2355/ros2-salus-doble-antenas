import type {
  Transport,
  TransportContext,
  TransportReceiveHandler,
  TransportStatusHandler
} from "../../../../../core/modules/runtime/transport/base/Transport";
import { decodeNav2Incoming, encodeNav2Outgoing, toNav2OutgoingMessage } from "../../../../protocol/messages";

export class HttpTransport implements Transport {
  readonly kind = "http";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();
  private baseUrl = "";

  constructor(readonly id: string, private readonly baseUrlResolver: (ctx: TransportContext) => string) {}

  async connect(ctx: TransportContext): Promise<void> {
    this.baseUrl = this.baseUrlResolver(ctx).replace(/\/$/, "");
    this.emitStatus(true, false, "");
  }

  async disconnect(): Promise<void> {
    this.baseUrl = "";
    this.emitStatus(false, true, "");
  }

  async send(packet: unknown): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(`HTTP transport '${this.id}' is disconnected`);
    }
    const outgoing = toNav2OutgoingMessage(packet);

    const response = await fetch(`${this.baseUrl}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodeNav2Outgoing(outgoing))
    });
    const incoming = decodeNav2Incoming(await response.json());
    if (!incoming) return;
    this.handlers.forEach((handler) => handler(incoming));
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeStatus(handler: TransportStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(connected: boolean, intentional: boolean, reason: string): void {
    this.statusHandlers.forEach((handler) => handler({ connected, intentional, reason }));
  }
}

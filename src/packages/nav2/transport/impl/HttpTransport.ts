import type { IncomingPacket, OutgoingPacket } from "../../../../core/types/message";
import type { Transport, TransportContext, TransportReceiveHandler } from "../../../core/transport/base/Transport";
import { decodeLegacyIncoming, encodeLegacyOutgoing } from "../../../core/transport/base/legacyCodec";

export class HttpTransport implements Transport {
  readonly kind = "http";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private baseUrl = "";

  constructor(readonly id: string, private readonly baseUrlResolver: (ctx: TransportContext) => string) {}

  async connect(ctx: TransportContext): Promise<void> {
    this.baseUrl = this.baseUrlResolver(ctx).replace(/\/$/, "");
  }

  async disconnect(): Promise<void> {
    // Stateless transport.
  }

  async send(packet: OutgoingPacket): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(`HTTP transport '${this.id}' is disconnected`);
    }

    const response = await fetch(`${this.baseUrl}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodeLegacyOutgoing(packet))
    });
    const incoming = decodeLegacyIncoming(await response.json());
    if (!incoming) return;
    this.handlers.forEach((handler) => handler(incoming));
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

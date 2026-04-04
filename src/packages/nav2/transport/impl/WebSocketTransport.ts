import type { IncomingPacket, OutgoingPacket } from "../../../../core/types/message";
import type { Transport, TransportContext, TransportReceiveHandler } from "../../../core/transport/base/Transport";
import { decodeLegacyIncoming, encodeLegacyOutgoing } from "../../../core/transport/base/legacyCodec";

export class WebSocketTransport implements Transport {
  readonly kind = "websocket";
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<TransportReceiveHandler>();
  private connectedUrl = "";

  constructor(readonly id: string, private readonly urlResolver: (ctx: TransportContext) => string) {}

  async connect(ctx: TransportContext): Promise<void> {
    const url = this.urlResolver(ctx);
    this.connectedUrl = url;
    if (typeof WebSocket === "undefined") return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`WebSocket connection failed: ${url}`));
      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
        }
      };
      socket.onmessage = (event) => {
        try {
          const parsed = decodeLegacyIncoming(JSON.parse(String(event.data)));
          if (!parsed) return;
          this.handlers.forEach((handler) => handler(parsed));
        } catch {
          // Ignore malformed payloads.
        }
      };
      this.ws = socket;
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  async send(packet: OutgoingPacket): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket transport '${this.id}' is disconnected (${this.connectedUrl || "unknown url"})`);
    }
    this.ws.send(JSON.stringify(encodeLegacyOutgoing(packet)));
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

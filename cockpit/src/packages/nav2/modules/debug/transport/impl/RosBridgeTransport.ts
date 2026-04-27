import type {
  Transport,
  TransportContext,
  TransportReceiveHandler,
  TransportStatusHandler
} from "../../../../../core/modules/runtime/transport/base/Transport";
import { decodeNav2Incoming, encodeNav2Outgoing, toNav2OutgoingMessage } from "../../../../protocol/messages";

export class RosBridgeTransport implements Transport {
  readonly kind = "rosbridge";
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();
  private disconnectRequested = false;

  constructor(readonly id: string, private readonly urlResolver: (ctx: TransportContext) => string) {}

  async connect(ctx: TransportContext): Promise<void> {
    const url = this.urlResolver(ctx);
    this.disconnectRequested = false;
    if (typeof WebSocket === "undefined") return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => {
        this.emitStatus(true, false, "");
        resolve();
      };
      socket.onerror = () => reject(new Error(`RosBridge connection failed: ${url}`));
      socket.onclose = (event) => {
        const intentional = this.disconnectRequested;
        if (this.ws === socket) {
          this.ws = null;
        }
        this.disconnectRequested = false;
        this.emitStatus(false, intentional, intentional ? "" : String(event.reason ?? "").trim());
      };
      socket.onmessage = (event) => {
        try {
          const parsed = decodeNav2Incoming(JSON.parse(String(event.data)));
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
    this.disconnectRequested = true;
    this.ws.close();
    this.ws = null;
  }

  async send(packet: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`RosBridge transport '${this.id}' is disconnected`);
    }
    const outgoing = toNav2OutgoingMessage(packet);
    this.ws.send(JSON.stringify(encodeNav2Outgoing(outgoing)));
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

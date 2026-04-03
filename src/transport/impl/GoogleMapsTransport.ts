import type { OutgoingPacket } from "../../core/types/message";
import type { Transport, TransportContext, TransportReceiveHandler } from "../base/Transport";

export class GoogleMapsTransport implements Transport {
  readonly kind = "google-maps";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private apiKey = "";

  constructor(readonly id: string) {}

  async connect(ctx: TransportContext): Promise<void> {
    this.apiKey = ctx.env.googleMapsApiKey;
  }

  async disconnect(): Promise<void> {
    this.apiKey = "";
  }

  async send(packet: OutgoingPacket): Promise<void> {
    const op = packet.op;
    if (op !== "google.maps.geocode") return;

    const payload = (packet.payload ?? {}) as Record<string, unknown>;
    const address = String(payload.address ?? "");
    if (!address || !this.apiKey) return;

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url.toString());
    const body = (await response.json()) as Record<string, unknown>;
    this.handlers.forEach((handler) =>
      handler({
        op: "google.maps.geocode.result",
        requestId: packet.requestId,
        ok: response.ok,
        payload: body as never
      })
    );
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}


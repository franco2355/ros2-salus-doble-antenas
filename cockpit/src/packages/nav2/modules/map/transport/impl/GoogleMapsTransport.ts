import type {
  Transport,
  TransportContext,
  TransportReceiveHandler,
  TransportStatusHandler
} from "../../../../../core/modules/runtime/transport/base/Transport";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class GoogleMapsTransport implements Transport {
  readonly kind = "google-maps";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();
  private apiKey = "";

  constructor(readonly id: string) {}

  async connect(ctx: TransportContext): Promise<void> {
    this.apiKey = ctx.env.googleMapsApiKey;
    this.emitStatus(true, false, "");
  }

  async disconnect(): Promise<void> {
    this.apiKey = "";
    this.emitStatus(false, true, "");
  }

  async send(packet: unknown): Promise<void> {
    const raw = asRecord(packet);
    if (!raw) return;
    const op = String(raw.op ?? "");
    if (op !== "google.maps.geocode") return;

    const payload = asRecord(raw.payload) ?? {};
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
        requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
        ok: response.ok,
        payload: body as never
      })
    );
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

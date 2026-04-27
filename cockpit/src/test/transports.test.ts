import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../packages/nav2/modules/map/transport/impl/HttpTransport";
import { RosBridgeTransport } from "../packages/nav2/modules/debug/transport/impl/RosBridgeTransport";
import { WebSocketTransport } from "../packages/nav2/modules/navigation/transport/impl/WebSocketTransport";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  closeWithReason(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  emitJson(payload: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

describe("transport contracts", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("WebSocketTransport connect/send/recv/disconnect", async () => {
    const transport = new WebSocketTransport("ws", () => "ws://localhost:1234");
    const received: string[] = [];
    const receivedRequestIds: string[] = [];
    const statuses: Array<{ connected: boolean; intentional: boolean; reason: string }> = [];
    transport.recv((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const packet = message as Record<string, unknown>;
      received.push(String(packet.op ?? ""));
      if (typeof packet.requestId === "string") {
        receivedRequestIds.push(packet.requestId);
      }
    });
    transport.subscribeStatus((status) => {
      statuses.push(status);
    });

    await transport.connect({ env: {} as never });
    await transport.send({ op: "hello", requestId: "abc-123" });

    const socket = (transport as unknown as { ws: FakeWebSocket }).ws;
    expect(socket?.sent[0]).toContain("\"requestId\":\"abc-123\"");
    expect(socket?.sent[0]).toContain("\"client_req_id\":\"abc-123\"");
    socket?.emitJson({ op: "hello.result", ok: true, requestId: "abc-123" });
    expect(received).toEqual(["hello.result"]);
    expect(receivedRequestIds).toEqual(["abc-123"]);

    await transport.disconnect();
    expect(statuses).toContainEqual({ connected: true, intentional: false, reason: "" });
    expect(statuses).toContainEqual({ connected: false, intentional: true, reason: "" });
  });

  it("WebSocketTransport emits unexpected disconnect status on remote close", async () => {
    const transport = new WebSocketTransport("ws", () => "ws://localhost:1234");
    const statuses: Array<{ connected: boolean; intentional: boolean; reason: string }> = [];
    transport.subscribeStatus((status) => {
      statuses.push(status);
    });

    await transport.connect({ env: {} as never });
    const socket = (transport as unknown as { ws: FakeWebSocket }).ws;
    socket?.closeWithReason(1006, "backend dropped");

    expect(statuses).toContainEqual({
      connected: false,
      intentional: false,
      reason: "backend dropped"
    });
  });

  it("RosBridgeTransport connect/send/recv/disconnect", async () => {
    const transport = new RosBridgeTransport("ros", () => "ws://localhost:9090");
    const received: string[] = [];
    transport.recv((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const packet = message as Record<string, unknown>;
      received.push(String(packet.op ?? ""));
    });
    await transport.connect({ env: {} as never });
    await transport.send({ op: "mission.start" });

    const socket = (transport as unknown as { ws: FakeWebSocket }).ws;
    socket?.emitJson({ op: "mission.status.update", payload: { status: "running" } });
    expect(received).toContain("mission.status.update");
    await transport.disconnect();
  });

  it("HttpTransport connect/send/recv", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ op: "map.loaded", ok: true, payload: { mapId: "default" } })
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = new HttpTransport("http", () => "http://localhost:8080");
    const received: string[] = [];
    transport.recv((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const packet = message as Record<string, unknown>;
      received.push(String(packet.op ?? ""));
    });
    await transport.connect({ env: {} as never });
    await transport.send({ op: "map.request", payload: { mapId: "default" } as never });
    expect(received).toEqual(["map.loaded"]);
    expect(fetchMock).toHaveBeenCalled();
  });

  afterEach(() => {
    vi.stubGlobal("WebSocket", originalWebSocket as unknown as typeof WebSocket);
  });
});

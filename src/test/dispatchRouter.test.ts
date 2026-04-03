import { beforeEach, describe, expect, it } from "vitest";
import { DispatchRouter } from "../dispatcher/DispatchRouter";
import { DispatcherBase } from "../dispatcher/base/Dispatcher";
import type { IncomingPacket, OutgoingPacket } from "../core/types/message";
import type { Transport, TransportContext, TransportReceiveHandler } from "../transport/base/Transport";
import { TransportManager } from "../transport/manager/TransportManager";

class MockTransport implements Transport {
  readonly kind = "mock";
  private readonly handlers = new Set<TransportReceiveHandler>();
  lastSent: OutgoingPacket | null = null;
  connected = false;

  constructor(readonly id: string) {}

  async connect(_ctx: TransportContext): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(packet: OutgoingPacket): Promise<void> {
    this.lastSent = packet;
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(message: IncomingPacket): void {
    this.handlers.forEach((handler) => handler(message));
  }
}

class TestDispatcher extends DispatcherBase {
  seen: IncomingPacket[] = [];

  constructor(id: string, transportId: string, ops: string[]) {
    super(id, transportId, ops);
  }

  handleIncoming(message: IncomingPacket): void {
    this.seen.push(message);
    this.publish(message.op, message);
  }
}

describe("DispatchRouter", () => {
  let manager: TransportManager;
  let router: DispatchRouter;
  let transport: MockTransport;

  beforeEach(() => {
    manager = new TransportManager();
    router = new DispatchRouter(manager);
    transport = new MockTransport("transport.mock");
    manager.registerTransport(transport);
    router.bindTransport(transport.id);
  });

  it("routes inbound messages by op and transport", () => {
    const dispatcher = new TestDispatcher("dispatcher.robot", transport.id, ["robot.status.update"]);
    router.registerDispatcher(dispatcher);

    transport.emit({ op: "robot.status.update", payload: { connected: true } as never });
    expect(dispatcher.seen).toHaveLength(1);
    expect(dispatcher.seen[0].transportId).toBe(transport.id);
  });

  it("resolves request/response correlation by requestId", async () => {
    const requestPromise = router.request(transport.id, "robot.status.get", { verbose: true } as never, {
      timeoutMs: 1500
    });
    const requestId = transport.lastSent?.requestId;
    expect(requestId).toBeTruthy();

    transport.emit({
      op: "robot.status.get.result",
      requestId,
      ok: true,
      payload: { connected: true } as never
    });

    await expect(requestPromise).resolves.toMatchObject({ ok: true });
  });

  it("times out unresolved requests", async () => {
    await expect(
      router.request(transport.id, "never.responds", {} as never, { timeoutMs: 15 })
    ).rejects.toThrow("timeout");
  });
});


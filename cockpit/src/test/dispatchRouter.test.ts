import { beforeEach, describe, expect, it } from "vitest";
import { DispatchRouter } from "../packages/core/modules/runtime/dispatcher/DispatchRouter";
import { DispatcherBase } from "../packages/core/modules/runtime/dispatcher/base/Dispatcher";
import type {
  Transport,
  TransportContext,
  TransportReceiveHandler,
  TransportStatusHandler
} from "../packages/core/modules/runtime/transport/base/Transport";
import { TransportManager } from "../packages/core/modules/runtime/transport/manager/TransportManager";

class MockTransport implements Transport {
  readonly kind = "mock";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();
  lastSent: unknown = null;
  connected = false;

  constructor(readonly id: string) {}

  async connect(_ctx: TransportContext): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(packet: unknown): Promise<void> {
    this.lastSent = packet;
  }

  recv(handler: TransportReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeStatus(handler: TransportStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emit(message: unknown): void {
    this.handlers.forEach((handler) => handler(message));
  }
}

class TestDispatcher extends DispatcherBase {
  seen = new Array<{ raw: unknown; transportId: string }>();

  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  handleIncoming(raw: unknown, transportId: string): void {
    this.seen.push({ raw, transportId });
  }

  async send(raw: unknown): Promise<void> {
    await this.sendRaw(raw);
  }
}

describe("DispatchRouter", () => {
  let manager: TransportManager;
  let router: DispatchRouter;
  let transportA: MockTransport;
  let transportB: MockTransport;

  beforeEach(() => {
    manager = new TransportManager();
    router = new DispatchRouter(manager);
    transportA = new MockTransport("transport.a");
    transportB = new MockTransport("transport.b");
    manager.registerTransport(transportA);
    manager.registerTransport(transportB);
    router.bindTransport(transportA.id);
    router.bindTransport(transportB.id);
  });

  it("fanouts inbound raw messages to dispatchers bound to the same transport", () => {
    const first = new TestDispatcher("dispatcher.first", transportA.id);
    const second = new TestDispatcher("dispatcher.second", transportA.id);
    router.registerDispatcher(first);
    router.registerDispatcher(second);

    const incoming = { op: "nav_telemetry", payload: { connected: true } };
    transportA.emit(incoming);

    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    expect(first.seen[0].raw).toEqual(incoming);
    expect(first.seen[0].transportId).toBe(transportA.id);
    expect(second.seen[0].transportId).toBe(transportA.id);
  });

  it("does not deliver inbound raw messages to dispatchers on other transports", () => {
    const onA = new TestDispatcher("dispatcher.a", transportA.id);
    const onB = new TestDispatcher("dispatcher.b", transportB.id);
    router.registerDispatcher(onA);
    router.registerDispatcher(onB);

    transportA.emit({ op: "map.loaded" });
    expect(onA.seen).toHaveLength(1);
    expect(onB.seen).toHaveLength(0);
  });

  it("sends opaque raw payload through sendRaw", async () => {
    const packet = { op: "set_goal_ll", requestId: "r-1", payload: { x: 1 } };
    await router.sendRaw(transportA.id, packet);
    expect(transportA.lastSent).toEqual(packet);
  });

  it("allows package-owned dispatchers to send raw payload through protected sendRaw", async () => {
    const dispatcher = new TestDispatcher("dispatcher.tx", transportA.id);
    router.registerDispatcher(dispatcher);
    const packet = { op: "mission.start", payload: { missionId: "m1" } };

    await dispatcher.send(packet);
    expect(transportA.lastSent).toEqual(packet);
  });
});

import { describe, expect, it } from "vitest";
import { MetricsService } from "../packages/core/modules/metrics/service/impl/MetricsService";
import type { Transport, TransportReceiveHandler, TransportStatusHandler } from "../packages/core/modules/runtime/transport/base/Transport";
import { TransportManager } from "../packages/core/modules/runtime/transport/manager/TransportManager";

class FakeTransport implements Transport {
  readonly kind = "fake";
  private readonly handlers = new Set<TransportReceiveHandler>();
  private readonly statusHandlers = new Set<TransportStatusHandler>();

  constructor(readonly id: string) {}

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async send(_packet: unknown): Promise<void> {
    return Promise.resolve();
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

describe("MetricsService", () => {
  it("aggregates traffic across all registered transports and emits consistent snapshots", async () => {
    const manager = new TransportManager();
    const transportOne = new FakeTransport("transport.one");
    const transportTwo = new FakeTransport("transport.two");
    manager.registerTransport(transportOne);
    manager.registerTransport(transportTwo);

    const service = new MetricsService(manager);
    const snapshots = new Array<{ txBytes: number; rxBytes: number; totalBytes: number }>();
    const unsubscribeService = service.subscribe((state) => {
      snapshots.push(state);
    });

    const unsubscribeRecvOne = manager.recv("transport.one", () => undefined);
    const unsubscribeRecvTwo = manager.recv("transport.two", () => undefined);

    await manager.send("transport.one", { op: "a" });
    await manager.send("transport.two", { op: "b", payload: { value: 1 } as never });
    transportOne.emit({ op: "a.result", payload: { ok: true } as never });
    transportTwo.emit({ op: "b.result" });

    const statsOne = manager.getTrafficStats("transport.one");
    const statsTwo = manager.getTrafficStats("transport.two");
    const final = service.getState();
    expect(final.txBytes).toBe(statsOne.txBytes + statsTwo.txBytes);
    expect(final.rxBytes).toBe(statsOne.rxBytes + statsTwo.rxBytes);
    expect(final.totalBytes).toBe(final.txBytes + final.rxBytes);
    expect(snapshots.length).toBeGreaterThan(1);
    snapshots.forEach((snapshot) => {
      expect(snapshot.totalBytes).toBe(snapshot.txBytes + snapshot.rxBytes);
    });

    unsubscribeRecvOne();
    unsubscribeRecvTwo();
    unsubscribeService();
    service.dispose();
  });
});

import { describe, expect, it } from "vitest";
import type { DispatchRouter } from "../packages/core/modules/runtime/dispatcher/DispatchRouter";
import type { RequestOptions } from "../packages/core/modules/runtime/dispatcher/base/Dispatcher";
import { Nav2DispatcherBase } from "../packages/nav2/protocol/Nav2DispatcherBase";
import {
  decodeNav2Incoming,
  encodeNav2Outgoing,
  type Nav2IncomingMessage,
  toNav2OutgoingMessage
} from "../packages/nav2/protocol/messages";

class TestNav2Dispatcher extends Nav2DispatcherBase {
  constructor() {
    super("dispatcher.test", "transport.test");
  }

  async requestPing(payload?: unknown, options?: RequestOptions): Promise<Nav2IncomingMessage> {
    return this.request("ping", payload, options);
  }
}

describe("nav2 protocol", () => {
  it("encodes outbound payload with legacy request alias and flattened payload fields", () => {
    const outgoing = toNav2OutgoingMessage({
      op: "set_goal_ll",
      requestId: "r-1",
      payload: {
        waypoints: [{ lat: 1, lon: 2, yaw_deg: 3 }],
        locked: false
      }
    });
    const encoded = encodeNav2Outgoing(outgoing);
    expect(encoded).toMatchObject({
      op: "set_goal_ll",
      requestId: "r-1",
      client_req_id: "r-1",
      locked: false
    });
    expect(encoded.payload).toMatchObject({
      waypoints: [{ lat: 1, lon: 2, yaw_deg: 3 }],
      locked: false
    });
  });

  it("decodes inbound aliases for correlation fields and payload flattening", () => {
    const decoded = decodeNav2Incoming({
      op: "ack",
      client_req_id: "r-1",
      ok: true,
      payload: { accepted: true, request: "set_control_lock", locked: true }
    });
    expect(decoded).toMatchObject({
      op: "ack",
      requestId: "r-1",
      request: "set_control_lock",
      ok: true,
      accepted: true,
      locked: true
    });
  });

  it("correlates request/response by requestId inside nav2 dispatcher base", async () => {
    const dispatcher = new TestNav2Dispatcher();
    const sent: unknown[] = [];
    const fakeRouter = {
      async sendRaw(_transportId: string, raw: unknown): Promise<void> {
        sent.push(raw);
      }
    };
    dispatcher.setRouter(fakeRouter as unknown as DispatchRouter);

    const requestPromise = dispatcher.requestPing({ value: 1 }, { timeoutMs: 500 });
    expect(sent).toHaveLength(1);
    const outgoing = sent[0] as Record<string, unknown>;
    const requestId = String(outgoing.requestId ?? "");
    expect(requestId).not.toBe("");

    dispatcher.handleIncoming(
      {
        op: "ack",
        requestId,
        ok: true,
        payload: { accepted: true }
      },
      "transport.test"
    );

    await expect(requestPromise).resolves.toMatchObject({
      op: "ack",
      requestId,
      ok: true,
      transportId: "transport.test"
    });
  });

  it("times out unresolved nav2 requests", async () => {
    const dispatcher = new TestNav2Dispatcher();
    dispatcher.setRouter(
      {
        async sendRaw(): Promise<void> {
          return Promise.resolve();
        }
      } as unknown as DispatchRouter
    );

    await expect(dispatcher.requestPing({}, { timeoutMs: 15 })).rejects.toThrow("timeout");
  });

  it("correlates request/response when backend replies with client_req_id", async () => {
    const dispatcher = new TestNav2Dispatcher();
    const sent: unknown[] = [];
    const fakeRouter = {
      async sendRaw(_transportId: string, raw: unknown): Promise<void> {
        sent.push(raw);
      }
    };
    dispatcher.setRouter(fakeRouter as unknown as DispatchRouter);

    const requestPromise = dispatcher.requestPing({ value: 1 }, { timeoutMs: 500 });
    expect(sent).toHaveLength(1);
    const outgoing = sent[0] as Record<string, unknown>;
    const requestId = String(outgoing.requestId ?? "");
    expect(requestId).not.toBe("");

    dispatcher.handleIncoming(
      {
        op: "ack",
        client_req_id: requestId,
        ok: true
      },
      "transport.test"
    );

    await expect(requestPromise).resolves.toMatchObject({
      op: "ack",
      requestId,
      ok: true,
      transportId: "transport.test"
    });
  });

  it("correlates request/response when backend replies with ack.request only", async () => {
    const dispatcher = new TestNav2Dispatcher();
    const sent: unknown[] = [];
    const fakeRouter = {
      async sendRaw(_transportId: string, raw: unknown): Promise<void> {
        sent.push(raw);
      }
    };
    dispatcher.setRouter(fakeRouter as unknown as DispatchRouter);

    const requestPromise = dispatcher.requestPing({ value: 1 }, { timeoutMs: 500 });
    expect(sent).toHaveLength(1);

    dispatcher.handleIncoming(
      {
        op: "ack",
        request: "ping",
        ok: true
      },
      "transport.test"
    );

    await expect(requestPromise).resolves.toMatchObject({
      op: "ack",
      request: "ping",
      ok: true,
      transportId: "transport.test"
    });
  });
});

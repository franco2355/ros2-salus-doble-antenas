import type { OutgoingPacket } from "../../core/types/message";
import type { Transport, TransportContext } from "../base/Transport";

export class TransportManager {
  private readonly transports = new Map<string, Transport>();

  registerTransport(transport: Transport): void {
    if (this.transports.has(transport.id)) {
      throw new Error(`Transport collision: '${transport.id}' already exists`);
    }
    this.transports.set(transport.id, transport);
  }

  unregisterTransport(transportId: string): void {
    this.transports.delete(transportId);
  }

  getTransport(transportId: string): Transport | undefined {
    return this.transports.get(transportId);
  }

  listTransports(): Transport[] {
    return [...this.transports.values()];
  }

  async connectAll(ctx: TransportContext): Promise<void> {
    const tasks = this.listTransports().map(async (transport) => {
      await transport.connect(ctx);
    });
    await Promise.allSettled(tasks);
  }

  async connectTransport(transportId: string, ctx: TransportContext): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    await transport.connect(ctx);
  }

  async disconnectAll(): Promise<void> {
    const tasks = this.listTransports().map(async (transport) => {
      await transport.disconnect();
    });
    await Promise.allSettled(tasks);
  }

  async disconnectTransport(transportId: string): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    await transport.disconnect();
  }

  async send(transportId: string, packet: OutgoingPacket): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }
    await transport.send(packet);
  }
}

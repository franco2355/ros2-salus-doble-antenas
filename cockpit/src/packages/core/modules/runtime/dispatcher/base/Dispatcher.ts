import type { DispatchRouter } from "../DispatchRouter";

export interface RequestOptions {
  timeoutMs?: number;
}

export interface Dispatcher {
  id: string;
  transportId: string;
  setRouter(router: DispatchRouter): void;
  handleIncoming(raw: unknown, transportId: string): void;
}

export abstract class DispatcherBase implements Dispatcher {
  private router: DispatchRouter | null = null;

  constructor(
    readonly id: string,
    readonly transportId: string
  ) {}

  setRouter(router: DispatchRouter): void {
    this.router = router;
  }

  protected async sendRaw(raw: unknown): Promise<void> {
    if (!this.router) {
      throw new Error(`Dispatcher '${this.id}' is not attached to a router`);
    }
    await this.router.sendRaw(this.transportId, raw);
  }

  abstract handleIncoming(raw: unknown, transportId: string): void;
}

export type EventHandler<TPayload = unknown> = (payload: TPayload) => void;

export interface EventBus {
  emit<TPayload>(event: string, payload: TPayload): void;
  on<TPayload>(event: string, handler: EventHandler<TPayload>): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<EventHandler>>();

  return {
    emit<TPayload>(event: string, payload: TPayload): void {
      const handlers = listeners.get(event);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    },
    on<TPayload>(event: string, handler: EventHandler<TPayload>): () => void {
      const set = listeners.get(event) ?? new Set<EventHandler>();
      set.add(handler as EventHandler);
      listeners.set(event, set);
      return () => {
        const current = listeners.get(event);
        if (!current) return;
        current.delete(handler as EventHandler);
        if (current.size === 0) {
          listeners.delete(event);
        }
      };
    }
  };
}


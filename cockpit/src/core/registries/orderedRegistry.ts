export interface RegistryItem {
  id: string;
}

export class OrderedRegistry<T extends RegistryItem> {
  private readonly items = new Map<string, T>();

  register(item: T): void {
    if (this.items.has(item.id)) {
      throw new Error(`Registry collision: '${item.id}' already exists`);
    }
    this.items.set(item.id, item);
  }

  unregister(id: string): void {
    this.items.delete(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  list(): T[] {
    return [...this.items.values()];
  }
}

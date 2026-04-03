export interface Container {
  set<T>(key: string, value: T): void;
  get<T>(key: string): T;
  has(key: string): boolean;
}

export function createContainer(): Container {
  const store = new Map<string, unknown>();

  return {
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    get<T>(key: string): T {
      if (!store.has(key)) {
        throw new Error(`Container key not found: ${key}`);
      }
      return store.get(key) as T;
    },
    has(key: string): boolean {
      return store.has(key);
    }
  };
}


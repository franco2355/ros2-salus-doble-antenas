import { hostRequest } from "./bridge";

const STORAGE_PREFIX = "cockpit.config.";
const memoryStorage = new Map<string, string>();

function fallbackGetItem(key: string): string | null {
  return memoryStorage.has(key) ? memoryStorage.get(key)! : null;
}

function fallbackSetItem(key: string, value: string): void {
  memoryStorage.set(key, value);
}

function fallbackRemoveItem(key: string): void {
  memoryStorage.delete(key);
}

function getBrowserStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  if (
    typeof window !== "undefined" &&
    window.localStorage &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function" &&
    typeof window.localStorage.removeItem === "function"
  ) {
    return window.localStorage;
  }
  return {
    getItem: fallbackGetItem,
    setItem: fallbackSetItem,
    removeItem: fallbackRemoveItem
  };
}

export async function readConfig(relativePath: string): Promise<string | null> {
  const hostResult = await hostRequest<unknown>("host.config.read", { relativePath });
  if (typeof hostResult === "string" || hostResult === null) return hostResult;
  return getBrowserStorage().getItem(`${STORAGE_PREFIX}${relativePath}`);
}

export async function writeConfig(relativePath: string, content: string): Promise<void> {
  const hostResult = await hostRequest<unknown>("host.config.write", { relativePath, content });
  if (hostResult !== undefined) return;
  getBrowserStorage().setItem(`${STORAGE_PREFIX}${relativePath}`, content);
}

export async function removeConfig(relativePath: string): Promise<void> {
  const hostResult = await hostRequest<unknown>("host.config.remove", { relativePath });
  if (hostResult !== undefined) return;
  getBrowserStorage().removeItem(`${STORAGE_PREFIX}${relativePath}`);
}

export async function watchConfig(
  _relativePath: string,
  _onChange: (content: string | null) => void
): Promise<() => void> {
  return () => {
    // Bridge watch not implemented yet.
  };
}

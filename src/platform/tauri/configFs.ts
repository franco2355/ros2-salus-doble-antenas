import { invokeCommand } from "./commands";

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
  const tauriResult = await invokeCommand<string | null>("read_config_file", { relativePath });
  if (tauriResult !== undefined) return tauriResult;

  return getBrowserStorage().getItem(`${STORAGE_PREFIX}${relativePath}`);
}

export async function writeConfig(relativePath: string, content: string): Promise<void> {
  const tauriResult = await invokeCommand("write_config_file", { relativePath, content });
  if (tauriResult !== undefined) return;

  getBrowserStorage().setItem(`${STORAGE_PREFIX}${relativePath}`, content);
}

export async function removeConfig(relativePath: string): Promise<void> {
  const tauriResult = await invokeCommand("delete_config_file", { relativePath });
  if (tauriResult !== undefined) return;
  getBrowserStorage().removeItem(`${STORAGE_PREFIX}${relativePath}`);
}

export async function watchConfig(
  _relativePath: string,
  _onChange: (content: string | null) => void
): Promise<() => void> {
  const tauriResult = await invokeCommand("watch_config_file", { relativePath: _relativePath });
  if (tauriResult !== undefined) {
    return () => {
      void invokeCommand("unwatch_config_file", { relativePath: _relativePath });
    };
  }
  return () => {
    // Browser fallback does not support watch.
  };
}

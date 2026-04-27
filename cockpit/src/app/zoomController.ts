import { setWebviewZoom } from "../platform/host/webviewZoom";

export interface ZoomStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UiZoomControllerOptions {
  storage?: ZoomStorageAdapter;
  storageKey?: string;
  applyZoomFn?: (scaleFactor: number) => Promise<void>;
}

const zoomMemoryStorage = new Map<string, string>();

export const UI_ZOOM_STORAGE_KEY = "cockpit.ui.zoom.v1";
export const UI_ZOOM_DEFAULT_SCALE = 1;
export const UI_ZOOM_STEP = 0.1;
export const UI_ZOOM_MIN_SCALE = 0.5;
export const UI_ZOOM_MAX_SCALE = 3;

export function getZoomStorageAdapter(): ZoomStorageAdapter {
  if (
    typeof window !== "undefined" &&
    window.localStorage &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function"
  ) {
    return window.localStorage;
  }
  return {
    getItem: (key: string) => (zoomMemoryStorage.has(key) ? zoomMemoryStorage.get(key)! : null),
    setItem: (key: string, value: string) => {
      zoomMemoryStorage.set(key, value);
    }
  };
}

export function clampZoomScale(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor)) return UI_ZOOM_DEFAULT_SCALE;
  const clamped = Math.min(UI_ZOOM_MAX_SCALE, Math.max(UI_ZOOM_MIN_SCALE, scaleFactor));
  return Math.round(clamped * 10) / 10;
}

export async function applyUiZoom(
  scaleFactor: number,
  setWebviewZoomFn: (scale: number) => Promise<boolean> = setWebviewZoom
): Promise<void> {
  const next = clampZoomScale(scaleFactor);
  const applied = await setWebviewZoomFn(next);
  if (applied) return;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.style.zoom = String(next);
  }
}

export class UiZoomController {
  private readonly storage: ZoomStorageAdapter;
  private readonly storageKey: string;
  private readonly applyZoomFn: (scaleFactor: number) => Promise<void>;
  private scaleFactor = UI_ZOOM_DEFAULT_SCALE;

  constructor(options: UiZoomControllerOptions = {}) {
    this.storage = options.storage ?? getZoomStorageAdapter();
    this.storageKey = options.storageKey ?? UI_ZOOM_STORAGE_KEY;
    this.applyZoomFn = options.applyZoomFn ?? ((scaleFactor) => applyUiZoom(scaleFactor));
  }

  getScaleFactor(): number {
    return this.scaleFactor;
  }

  async start(): Promise<void> {
    this.scaleFactor = this.readStoredScale();
    await this.applyZoomFn(this.scaleFactor);
  }

  async zoomIn(): Promise<number> {
    return this.setScale(this.scaleFactor + UI_ZOOM_STEP);
  }

  async zoomOut(): Promise<number> {
    return this.setScale(this.scaleFactor - UI_ZOOM_STEP);
  }

  async zoomReset(): Promise<number> {
    return this.setScale(UI_ZOOM_DEFAULT_SCALE);
  }

  private readStoredScale(): number {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return UI_ZOOM_DEFAULT_SCALE;
    return clampZoomScale(Number(raw));
  }

  private async setScale(scaleFactor: number): Promise<number> {
    const next = clampZoomScale(scaleFactor);
    this.scaleFactor = next;
    this.storage.setItem(this.storageKey, String(next));
    await this.applyZoomFn(next);
    return next;
  }
}

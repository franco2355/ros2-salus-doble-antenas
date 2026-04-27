import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UI_ZOOM_DEFAULT_SCALE,
  UI_ZOOM_MAX_SCALE,
  UI_ZOOM_MIN_SCALE,
  UiZoomController,
  applyUiZoom,
  clampZoomScale
} from "../app/zoomController";

function createStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}

describe("zoom controller", () => {
  beforeEach(() => {
    document.documentElement.style.zoom = "";
  });

  it("clamps zoom values", () => {
    expect(clampZoomScale(Number.NaN)).toBe(UI_ZOOM_DEFAULT_SCALE);
    expect(clampZoomScale(0.1)).toBe(UI_ZOOM_MIN_SCALE);
    expect(clampZoomScale(4)).toBe(UI_ZOOM_MAX_SCALE);
    expect(clampZoomScale(1.26)).toBe(1.3);
  });

  it("falls back to document zoom", async () => {
    await applyUiZoom(1.4, async () => false);
    expect(document.documentElement.style.zoom).toBe("1.4");
  });

  it("persists and restores zoom", async () => {
    const storage = createStorage();
    const applyZoomFn = vi.fn<(scaleFactor: number) => Promise<void>>().mockResolvedValue();
    const first = new UiZoomController({
      storage,
      storageKey: "test.zoom",
      applyZoomFn
    });

    await first.start();
    await first.zoomIn();
    await first.zoomIn();

    expect(first.getScaleFactor()).toBe(1.2);
    expect(storage.getItem("test.zoom")).toBe("1.2");

    const second = new UiZoomController({
      storage,
      storageKey: "test.zoom",
      applyZoomFn
    });

    await second.start();

    expect(second.getScaleFactor()).toBe(1.2);
    expect(applyZoomFn).toHaveBeenLastCalledWith(1.2);
  });

  it("clamps persisted updates at limits", async () => {
    const storage = createStorage();
    const applyZoomFn = vi.fn<(scaleFactor: number) => Promise<void>>().mockResolvedValue();
    const controller = new UiZoomController({
      storage,
      storageKey: "test.zoom",
      applyZoomFn
    });

    await controller.start();

    for (let index = 0; index < 40; index += 1) {
      await controller.zoomIn();
    }
    expect(controller.getScaleFactor()).toBe(UI_ZOOM_MAX_SCALE);

    for (let index = 0; index < 60; index += 1) {
      await controller.zoomOut();
    }
    expect(controller.getScaleFactor()).toBe(UI_ZOOM_MIN_SCALE);
  });
});

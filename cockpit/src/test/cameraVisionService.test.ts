import { describe, expect, it } from "vitest";
import { CameraVisionService } from "../packages/nav2/modules/camera/service/impl/CameraVisionService";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";

class FakeCameraDispatcher {
  private frameListener: ((msg: Nav2IncomingMessage) => void) | null = null;
  private detectionsListener: ((msg: Nav2IncomingMessage) => void) | null = null;

  subscribeFrame(callback: (msg: Nav2IncomingMessage) => void): () => void {
    this.frameListener = callback;
    return () => {
      if (this.frameListener === callback) {
        this.frameListener = null;
      }
    };
  }

  subscribeDetections(callback: (msg: Nav2IncomingMessage) => void): () => void {
    this.detectionsListener = callback;
    return () => {
      if (this.detectionsListener === callback) {
        this.detectionsListener = null;
      }
    };
  }

  emitFrame(message: Nav2IncomingMessage): void {
    this.frameListener?.(message);
  }
}

describe("CameraVisionService", () => {
  it("preserves PNG frames for the UI data URL", () => {
    const dispatcher = new FakeCameraDispatcher();
    const service = new CameraVisionService(dispatcher as never);

    dispatcher.emitFrame({
      op: "camera_frame",
      data: "ZmFrZS1wbmc=",
      encoding: "png",
      stamp_ms: 1713132000000,
      width: 640,
      height: 480
    });

    expect(service.getState().currentFrame).toMatchObject({
      encoding: "png",
      mimeType: "image/png",
      width: 640,
      height: 480
    });

    service.dispose();
  });

  it("keeps legacy frames compatible by defaulting to JPEG", () => {
    const dispatcher = new FakeCameraDispatcher();
    const service = new CameraVisionService(dispatcher as never);

    dispatcher.emitFrame({
      op: "camera_frame",
      data: "ZmFrZS1qcGVn"
    });

    expect(service.getState().currentFrame).toMatchObject({
      encoding: "jpeg",
      mimeType: "image/jpeg"
    });

    service.dispose();
  });
});

import { useEffect, useRef } from "react";
import type { UiZoomController } from "../zoomController";

interface ZoomHostProps {
  controller: UiZoomController;
}

const WHEEL_GESTURE_WINDOW_MS = 120;

export function ZoomHost({ controller }: ZoomHostProps): null {
  const wheelStateRef = useRef<{ time: number; direction: -1 | 0 | 1 }>({
    time: 0,
    direction: 0
  });

  useEffect(() => {
    void controller.start();
  }, [controller]);

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const direction = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
      if (!direction) return;

      event.preventDefault();

      const last = wheelStateRef.current;
      if (event.timeStamp - last.time < WHEEL_GESTURE_WINDOW_MS && last.direction === direction) {
        return;
      }

      wheelStateRef.current = {
        time: event.timeStamp,
        direction
      };

      if (direction < 0) {
        void controller.zoomIn();
        return;
      }
      void controller.zoomOut();
    };

    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [controller]);

  return null;
}

import { useEffect, useState } from "react";
import type { ModuleContext } from "../../../../../core/types/module";

interface ConsoleEventLike {
  level?: string;
  text?: string;
  timestamp?: number;
  source?: string;
}

interface TelemetryServiceLike {
  getSnapshot(): {
    recentEvents: Array<ConsoleEventLike>;
  };
  subscribeTelemetry(listener: (snapshot: ReturnType<TelemetryServiceLike["getSnapshot"]>) => void): () => void;
}

function normalizeEvent(event: ConsoleEventLike): Required<ConsoleEventLike> {
  return {
    level: String(event.level ?? "info"),
    text: String(event.text ?? "").trim(),
    timestamp: Number(event.timestamp ?? Date.now()),
    source: String(event.source ?? "system")
  };
}

export function LogConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [events, setEvents] = useState<Array<Required<ConsoleEventLike>>>([]);

  useEffect(() => {
    let telemetryService: TelemetryServiceLike | null = null;
    try {
      telemetryService = runtime.services.getService<TelemetryServiceLike>("service.telemetry");
    } catch {
      telemetryService = null;
    }

    if (telemetryService) {
      setEvents(
        telemetryService
          .getSnapshot()
          .recentEvents.map((entry) => normalizeEvent(entry))
          .filter((entry) => entry.text.length > 0)
      );
      return telemetryService.subscribeTelemetry((snapshot) => {
        setEvents(
          snapshot.recentEvents
            .map((entry) => normalizeEvent(entry))
            .filter((entry) => entry.text.length > 0)
        );
      });
    }

    return runtime.eventBus.on<ConsoleEventLike>("console.event", (event) => {
      const normalized = normalizeEvent(event);
      if (!normalized.text) return;
      setEvents((current) => [normalized, ...current].slice(0, 80));
    });
  }, [runtime]);

  return (
    <div className="cockpit-log-console" role="log" aria-live="polite">
      {events.length === 0 ? (
        <div className="cockpit-log-empty">No events.</div>
      ) : (
        events.map((entry, index) => (
          <div key={`${entry.timestamp}.${index}`} className={`cockpit-log-line log ${entry.level.toLowerCase()}`}>
            <span className="cockpit-log-ts log-ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span className="cockpit-log-src log-src">{entry.source}</span>
            <span className="cockpit-log-msg log-msg">{entry.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

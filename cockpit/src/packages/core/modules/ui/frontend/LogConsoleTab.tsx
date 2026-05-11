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

function LogEmptyState(): JSX.Element {
  return (
    <div className="cockpit-log-empty-state" role="status">
      <div className="cockpit-log-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none">
          <path d="M20 12h22l8 8v30a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6Z" stroke="currentColor" strokeWidth="2.6" />
          <path d="M42 12v9h8" stroke="currentColor" strokeWidth="2.6" />
          <path d="M23 28h4" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M33 28h10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M23 37h4" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M33 37h9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="45" cy="43" r="9" fill="#f8fbff" stroke="currentColor" strokeWidth="2.6" />
          <path d="m51.5 49.5 7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </div>
      <h3>No events yet</h3>
      <p>System logs, alerts, and telemetry messages will appear here as the monitoring happens.</p>
      <p>Use the tabs above to view data.</p>
      <div className="cockpit-log-empty-divider" aria-hidden="true" />
      <div className="cockpit-log-empty-tags" aria-hidden="true">
        <span className="cockpit-log-empty-tag cockpit-log-empty-tag-logs">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 4h12v15l-3.5-2-3 2-3-2L6 19V4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M9 8h6M9 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Logs
        </span>
        <span className="cockpit-log-empty-tag cockpit-log-empty-tag-alerts">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 4 21 20H3L12 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M12 9v5M12 17h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          Alerts
        </span>
        <span className="cockpit-log-empty-tag cockpit-log-empty-tag-telemetry">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 12h4l2-5 4 10 2-5h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Telemetry
        </span>
      </div>
    </div>
  );
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
    <div className={`cockpit-log-console${events.length === 0 ? " cockpit-log-console-empty" : ""}`} role="log" aria-live="polite">
      {events.length === 0 ? (
        <LogEmptyState />
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

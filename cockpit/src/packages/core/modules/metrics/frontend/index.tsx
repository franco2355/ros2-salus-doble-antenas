import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { METRICS_SERVICE_ID, MetricsService, type MetricsState } from "../service/impl/MetricsService";

function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function MetricsFooterItem({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<MetricsService>(METRICS_SERVICE_ID);
  const [state, setState] = useState<MetricsState>(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="metrics-footer">
      <span className="metrics-footer-item">TX {formatBytes(state.txBytes)}</span>
      <span className="metrics-footer-item">RX {formatBytes(state.rxBytes)}</span>
      <span className="metrics-footer-total">Total {formatBytes(state.totalBytes)}</span>
    </div>
  );
}

export function createMetricsModule(): CockpitModule {
  return {
    id: "metrics",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const metricsService = new MetricsService(ctx.transportManager);
      ctx.services.registerService({
        id: METRICS_SERVICE_ID,
        service: metricsService
      });

      ctx.contributions.register({
        id: "footer.metrics",
        slot: "footer",
        render: () => <MetricsFooterItem runtime={ctx} />
      });
    }
  };
}

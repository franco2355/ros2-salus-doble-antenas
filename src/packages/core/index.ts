import type { CockpitModule, CockpitPackage, ModuleContext } from "../../core/types/module";
import { createMetricsModule } from "./modules/metrics/frontend";

// UI components
export { ToolbarMenu } from "./modules/ui/frontend/ToolbarMenu";
export { ToolbarMenuItem } from "./modules/ui/frontend/ToolbarMenuItem";
export { Panel } from "./modules/ui/frontend/Panel";
export { PanelSection } from "./modules/ui/frontend/PanelSection";
export { PanelCollapsibleSection } from "./modules/ui/frontend/PanelCollapsibleSection";
export { WorkspacePanel } from "./modules/ui/frontend/WorkspacePanel";
export { ConsolePanel } from "./modules/ui/frontend/ConsolePanel";
export { Footer } from "./modules/ui/frontend/Footer";

// Dispatcher infrastructure
export { DispatcherBase } from "./modules/runtime/dispatcher/base/Dispatcher";
export type { Dispatcher, RequestOptions } from "./modules/runtime/dispatcher/base/Dispatcher";
export { DispatchRouter } from "./modules/runtime/dispatcher/DispatchRouter";

// Transport infrastructure
export type { Transport, TransportContext, TransportReceiveHandler } from "./modules/runtime/transport/base/Transport";
export { TransportManager } from "./modules/runtime/transport/manager/TransportManager";
export type { TransportTrafficStats } from "./modules/runtime/transport/manager/TransportManager";

// Core services
export { DialogService, DIALOG_SERVICE_ID } from "./modules/runtime/service/impl/DialogService";
export type { ActiveGlobalDialog } from "./modules/runtime/service/impl/DialogService";
export { SystemNotificationService, SYSTEM_NOTIFICATION_SERVICE_ID } from "./modules/runtime/service/impl/SystemNotificationService";
export { MetricsService, METRICS_SERVICE_ID } from "./modules/metrics/service/impl/MetricsService";

const uiModule: CockpitModule = {
  id: "ui",
  version: "1.0.0",
  enabledByDefault: true,
  register(_ctx: ModuleContext): void {}
};

const runtimeModule: CockpitModule = {
  id: "runtime",
  version: "1.0.0",
  enabledByDefault: true,
  register(_ctx: ModuleContext): void {}
};

export function createPackage(): CockpitPackage {
  return {
    id: "core",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [uiModule, runtimeModule, createMetricsModule()]
  };
}

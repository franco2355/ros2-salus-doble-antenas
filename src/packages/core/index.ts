// UI components
export { ToolbarMenu } from "./components/ToolbarMenu";
export { ToolbarMenuItem } from "./components/ToolbarMenuItem";
export { Panel } from "./components/Panel";
export { PanelSection } from "./components/PanelSection";
export { PanelCollapsibleSection } from "./components/PanelCollapsibleSection";
export { WorkspacePanel } from "./components/WorkspacePanel";
export { ConsolePanel } from "./components/ConsolePanel";
export { Footer } from "./components/Footer";

// Dispatcher infrastructure
export { DispatcherBase } from "./dispatcher/base/Dispatcher";
export type { Dispatcher, RequestOptions } from "./dispatcher/base/Dispatcher";
export { DispatchRouter } from "./dispatcher/DispatchRouter";

// Transport infrastructure
export type { Transport, TransportContext, TransportReceiveHandler } from "./transport/base/Transport";
export { TransportManager } from "./transport/manager/TransportManager";
export type { TransportTrafficStats } from "./transport/manager/TransportManager";
export { decodeLegacyIncoming, encodeLegacyOutgoing } from "./transport/base/legacyCodec";

// Core services
export { DialogService, DIALOG_SERVICE_ID } from "./services/impl/DialogService";
export type { ActiveGlobalDialog } from "./services/impl/DialogService";
export { SystemNotificationService, SYSTEM_NOTIFICATION_SERVICE_ID } from "./services/impl/SystemNotificationService";

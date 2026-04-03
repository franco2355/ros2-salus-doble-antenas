import type { DispatchRouter } from "../../dispatcher/DispatchRouter";
import type { TransportManager } from "../../transport/manager/TransportManager";
import type { EnvConfig } from "../config/envConfig";
import type { ModuleConfig } from "../config/moduleConfigLoader";
import type { Container } from "../di/container";
import type { EventBus } from "../events/eventBus";
import type { ConsoleTabRegistry } from "../registries/consoleTabRegistry";
import type { DispatcherRegistry } from "../registries/dispatcherRegistry";
import type { ModalRegistry } from "../registries/modalRegistry";
import type { ServiceRegistry } from "../registries/serviceRegistry";
import type { SidebarPanelRegistry } from "../registries/sidebarPanelRegistry";
import type { ToolbarMenuRegistry } from "../registries/toolbarMenuRegistry";
import type { TransportRegistry } from "../registries/transportRegistry";
import type { WorkspaceViewRegistry } from "../registries/workspaceViewRegistry";

export interface RegistryBundle {
  toolbarMenuRegistry: ToolbarMenuRegistry;
  sidebarPanelRegistry: SidebarPanelRegistry;
  workspaceViewRegistry: WorkspaceViewRegistry;
  consoleTabRegistry: ConsoleTabRegistry;
  modalRegistry: ModalRegistry;
  serviceRegistry: ServiceRegistry;
  dispatcherRegistry: DispatcherRegistry;
  transportRegistry: TransportRegistry;
}

export interface ModuleContext {
  env: EnvConfig;
  moduleConfig: ModuleConfig;
  container: Container;
  eventBus: EventBus;
  router: DispatchRouter;
  transportManager: TransportManager;
  registries: RegistryBundle;
}

export interface AppRuntime extends ModuleContext {
  getService<T>(serviceId: string): T;
}

export interface CockpitModule {
  id: string;
  version: string;
  enabledByDefault: boolean;
  register(ctx: ModuleContext): void | Promise<void>;
}


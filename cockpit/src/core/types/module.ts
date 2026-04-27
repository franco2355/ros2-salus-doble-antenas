import type { DispatchRouter } from "../../packages/core/modules/runtime/dispatcher/DispatchRouter";
import type { TransportManager } from "../../packages/core/modules/runtime/transport/manager/TransportManager";
import type { CommandRegistry } from "../commands/types";
import type { EnvConfig } from "../config/envConfig";
import type { ModuleConfig } from "../config/moduleConfigLoader";
import type { ContributionRegistry } from "../contributions/types";
import type { Container } from "../di/container";
import type { EventBus } from "../events/eventBus";
import type { KeybindingRegistry } from "../keybindings/types";
import type { DispatcherDefinition } from "../registries/dispatcherRegistry";
import type { ServiceDefinition } from "../registries/serviceRegistry";
import type { TransportDefinition } from "../registries/transportRegistry";
export type { CoreNotificationSettings } from "./settings";

export interface ServiceRegistryLike {
  registerService<T>(definition: ServiceDefinition<T>): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): ServiceDefinition | undefined;
  list(): ServiceDefinition[];
  getService<T>(id: string): T;
}

export interface DispatcherRegistryLike {
  registerDispatcher(definition: DispatcherDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): DispatcherDefinition | undefined;
  list(): DispatcherDefinition[];
}

export interface TransportRegistryLike {
  registerTransport(definition: TransportDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): TransportDefinition | undefined;
  list(): TransportDefinition[];
}

export interface ModuleContext {
  packageId: string;
  env: EnvConfig;
  moduleConfig: ModuleConfig;
  container: Container;
  eventBus: EventBus;
  router: DispatchRouter;
  transportManager: TransportManager;

  commands: CommandRegistry;
  contributions: ContributionRegistry;
  keybindings: KeybindingRegistry;

  services: ServiceRegistryLike;
  dispatchers: DispatcherRegistryLike;
  transports: TransportRegistryLike;

  packages: LoadedPackage[];
  getService<T>(serviceId: string): T;
  getPackageConfig<T extends Record<string, unknown>>(packageId: string): T;
  setPackageConfig(packageId: string, config: Record<string, unknown>): Promise<void>;
  resetPackageConfig(packageId: string): Promise<void>;
}

export interface AppRuntime extends ModuleContext {}

export type PackageSettingFieldType = "string" | "number" | "boolean" | "json";

export interface PackageSettingFieldSchema {
  key: string;
  label: string;
  type: PackageSettingFieldType;
  description?: string;
  placeholder?: string;
}

export interface PackageSettingsSchema {
  title?: string;
  fields: PackageSettingFieldSchema[];
}

export interface PackageConfigSchema {
  values: Record<string, unknown>;
  settings: PackageSettingsSchema;
}

export interface CockpitModule {
  id: string;
  version: string;
  enabledByDefault: boolean;
  register(ctx: ModuleContext): void | Promise<void>;
}

export interface CockpitPackage {
  id: string;
  version: string;
  enabledByDefault: boolean;
  modules: CockpitModule[];
}

export interface PackageCatalogEntry {
  path: string;
  cockpitPackage: CockpitPackage;
  packageConfig: PackageConfigSchema;
}

export interface LoadedPackage {
  id: string;
  version: string;
  enabled: boolean;
  moduleIds: string[];
  settingsSchema: PackageSettingsSchema;
}

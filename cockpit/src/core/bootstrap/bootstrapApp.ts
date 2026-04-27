import { DispatchRouter } from "../../packages/core/modules/runtime/dispatcher/DispatchRouter";
import { DIALOG_SERVICE_ID, DialogService } from "../../packages/core/modules/runtime/service/impl/DialogService";
import { SYSTEM_NOTIFICATION_SERVICE_ID, SystemNotificationService } from "../../packages/core/modules/runtime/service/impl/SystemNotificationService";
import { TransportManager } from "../../packages/core/modules/runtime/transport/manager/TransportManager";
import { createCommandRegistry } from "../commands/commandRegistry";
import { loadEnvConfig } from "../config/envConfig";
import { loadModuleConfig } from "../config/moduleConfigLoader";
import { createContributionRegistry } from "../contributions/contributionRegistry";
import { createContainer } from "../di/container";
import { createEventBus } from "../events/eventBus";
import { createKeybindingRegistry } from "../keybindings/keybindingRegistry";
import { DispatcherRegistry } from "../registries/dispatcherRegistry";
import { ServiceRegistry } from "../registries/serviceRegistry";
import { TransportRegistry } from "../registries/transportRegistry";
import type { AppRuntime } from "../types/module";
import { getPackageCatalog } from "./packageCatalog";
import { PackageManager } from "./packageManager";
import { registerCoreSettingsUi } from "./registerCoreSettingsUi";

export async function bootstrapApp(): Promise<AppRuntime> {
  const env = loadEnvConfig();
  const moduleConfig = await loadModuleConfig();
  const container = createContainer();
  const eventBus = createEventBus();
  const commands = createCommandRegistry();
  const contributions = createContributionRegistry();
  const keybindings = createKeybindingRegistry();
  const services = new ServiceRegistry();
  const dispatchers = new DispatcherRegistry();
  const transports = new TransportRegistry();
  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);

  const runtime: AppRuntime = {
    packageId: "core",
    env,
    moduleConfig,
    container,
    eventBus,
    router,
    transportManager,
    commands,
    contributions,
    keybindings,
    services,
    dispatchers,
    transports,
    packages: [],
    getService<T>(serviceId: string): T {
      if (services.has(serviceId)) {
        return services.getService<T>(serviceId);
      }
      const suffix = `.${serviceId}`;
      const matches = services.list().filter((entry) => entry.id.endsWith(suffix));
      if (matches.length === 1) {
        return matches[0].service as T;
      }
      throw new Error(`Service not found: ${serviceId}`);
    },
    getPackageConfig<T extends Record<string, unknown>>(_packageId: string): T {
      return {} as T;
    },
    async setPackageConfig(_packageId: string, _config: Record<string, unknown>): Promise<void> {
      return Promise.resolve();
    },
    async resetPackageConfig(_packageId: string): Promise<void> {
      return Promise.resolve();
    }
  };

  runtime.services.registerService({
    id: DIALOG_SERVICE_ID,
    service: new DialogService()
  });
  runtime.services.registerService({
    id: SYSTEM_NOTIFICATION_SERVICE_ID,
    service: new SystemNotificationService()
  });

  const packageCatalog = getPackageCatalog();
  const packageManager = new PackageManager(runtime, moduleConfig);
  runtime.getPackageConfig = <T extends Record<string, unknown>>(packageId: string): T =>
    packageManager.getPackageConfig<T>(packageId);
  runtime.setPackageConfig = async (packageId: string, config: Record<string, unknown>): Promise<void> => {
    await packageManager.setPackageConfig(packageId, config);
  };
  runtime.resetPackageConfig = async (packageId: string): Promise<void> => {
    await packageManager.resetPackageConfig(packageId);
  };
  const loadedPackages = await packageManager.registerPackages(packageCatalog);
  runtime.packages.splice(0, runtime.packages.length, ...loadedPackages);
  registerCoreSettingsUi(runtime);

  transports.list().forEach((entry) => {
    transportManager.registerTransport(entry.transport);
    router.bindTransport(entry.id);
  });

  dispatchers.list().forEach((entry) => {
    router.registerDispatcher(entry.dispatcher);
  });

  return runtime;
}

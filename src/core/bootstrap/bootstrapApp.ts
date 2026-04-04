import { DispatchRouter } from "../../dispatcher/DispatchRouter";
import { DIALOG_SERVICE_ID, DialogService } from "../../services/impl/DialogService";
import { TransportManager } from "../../transport/manager/TransportManager";
import { loadEnvConfig } from "../config/envConfig";
import { loadModuleConfig } from "../config/moduleConfigLoader";
import { createContainer } from "../di/container";
import { createEventBus } from "../events/eventBus";
import { createRegistries } from "../registries/createRegistries";
import type { AppRuntime } from "../types/module";
import { getPackageCatalog } from "./packageCatalog";
import { PackageManager } from "./packageManager";
import { registerCoreSettingsUi } from "./registerCoreSettingsUi";

export async function bootstrapApp(): Promise<AppRuntime> {
  const env = loadEnvConfig();
  const moduleConfig = await loadModuleConfig();
  const container = createContainer();
  const eventBus = createEventBus();
  const registries = createRegistries();
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
    registries,
    packages: [],
    getService<T>(serviceId: string): T {
      if (registries.serviceRegistry.has(serviceId)) {
        return registries.serviceRegistry.getService<T>(serviceId);
      }
      const suffix = `.${serviceId}`;
      const matches = registries.serviceRegistry.list().filter((entry) => entry.id.endsWith(suffix));
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

  runtime.registries.serviceRegistry.registerService({
    id: DIALOG_SERVICE_ID,
    order: 0,
    service: new DialogService()
  });

  registerCoreSettingsUi(runtime);

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

  registries.transportRegistry.list().forEach((entry) => {
    transportManager.registerTransport(entry.transport);
    router.bindTransport(entry.id);
  });

  registries.dispatcherRegistry.list().forEach((entry) => {
    router.registerDispatcher(entry.dispatcher);
  });

  await transportManager.connectAll({ env });

  return runtime;
}

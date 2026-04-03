import { DispatchRouter } from "../../dispatcher/DispatchRouter";
import { TransportManager } from "../../transport/manager/TransportManager";
import { loadEnvConfig } from "../config/envConfig";
import { isModuleEnabled, loadModuleConfig } from "../config/moduleConfigLoader";
import { createContainer } from "../di/container";
import { createEventBus } from "../events/eventBus";
import { createRegistries } from "../registries/createRegistries";
import type { AppRuntime } from "../types/module";
import { getModuleCatalog } from "./moduleCatalog";

export async function bootstrapApp(): Promise<AppRuntime> {
  const env = loadEnvConfig();
  const moduleConfig = await loadModuleConfig();
  const container = createContainer();
  const eventBus = createEventBus();
  const registries = createRegistries();
  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);

  const runtime: AppRuntime = {
    env,
    moduleConfig,
    container,
    eventBus,
    router,
    transportManager,
    registries,
    getService<T>(serviceId: string): T {
      return registries.serviceRegistry.getService<T>(serviceId);
    }
  };

  const catalog = getModuleCatalog();
  const enabledModules = catalog.filter((module) => isModuleEnabled(module, moduleConfig));

  for (const module of enabledModules) {
    await module.register(runtime);
  }

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


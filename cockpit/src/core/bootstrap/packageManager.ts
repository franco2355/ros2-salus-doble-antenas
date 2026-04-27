import type { CommandDescriptor, CommandHandler, CommandRegistry } from "../commands/types";
import { isPackageEnabled, isPackageModuleEnabled, type ModuleConfig } from "../config/moduleConfigLoader";
import {
  loadPackageConfigOverride,
  mergePackageConfig,
  resetPackageConfigOverride,
  savePackageConfigOverride
} from "../config/packageConfigLoader";
import type { ContributionRegistry, UIContribution } from "../contributions/types";
import { CORE_EVENTS } from "../events/topics";
import type { KeybindingDescriptor, KeybindingRegistry } from "../keybindings/types";
import type { Dispatcher } from "../../packages/core/modules/runtime/dispatcher/base/Dispatcher";
import type { Transport } from "../../packages/core/modules/runtime/transport/base/Transport";
import type { DispatcherDefinition } from "../registries/dispatcherRegistry";
import type { ServiceDefinition } from "../registries/serviceRegistry";
import type { TransportDefinition } from "../registries/transportRegistry";
import type {
  AppRuntime,
  DispatcherRegistryLike,
  LoadedPackage,
  PackageCatalogEntry,
  ServiceRegistryLike,
  TransportRegistryLike
} from "../types/module";

function scopeId(packageId: string, id: string): string {
  if (id.startsWith(`${packageId}.`)) {
    return id;
  }
  return `${packageId}.${id}`;
}

function resolveLookupId(
  packageId: string,
  id: string,
  has: (entryId: string) => boolean
): string {
  if (has(id)) return id;
  const scoped = scopeId(packageId, id);
  if (has(scoped)) return scoped;
  return id;
}

function areConfigValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  return false;
}

function computePackageConfigOverride(
  baseConfig: Record<string, unknown>,
  mergedConfig: Record<string, unknown>
): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mergedConfig)) {
    if (!areConfigValuesEqual(value, baseConfig[key])) {
      override[key] = value;
    }
  }
  return override;
}

function resolveCommandReference(rootRuntime: AppRuntime, packageId: string, commandId: string): string {
  if (rootRuntime.commands.has(commandId)) return commandId;
  const scoped = scopeId(packageId, commandId);
  if (rootRuntime.commands.has(scoped)) return scoped;
  return commandId;
}

function scopeToolbarContributionCommandIds(
  rootRuntime: AppRuntime,
  packageId: string,
  contribution: UIContribution
): UIContribution {
  if (contribution.slot !== "toolbar") {
    return contribution;
  }

  return {
    ...contribution,
    commandId: contribution.commandId
      ? resolveCommandReference(rootRuntime, packageId, contribution.commandId)
      : undefined,
    items: contribution.items?.map((item) => ({
      ...item,
      id: scopeId(packageId, item.id),
      commandId: resolveCommandReference(rootRuntime, packageId, item.commandId)
    }))
  };
}

function createScopedRuntime(rootRuntime: AppRuntime, packageId: string): AppRuntime {
  const commands: CommandRegistry = {
    register(descriptor: CommandDescriptor, handler: CommandHandler) {
      return rootRuntime.commands.register({ ...descriptor, id: scopeId(packageId, descriptor.id) }, handler);
    },
    execute(commandId: string, ...args: unknown[]) {
      const resolved = resolveLookupId(packageId, commandId, (entryId) => rootRuntime.commands.has(entryId));
      return rootRuntime.commands.execute(resolved, ...args);
    },
    has(commandId: string): boolean {
      return rootRuntime.commands.has(resolveLookupId(packageId, commandId, (entryId) => rootRuntime.commands.has(entryId)));
    },
    getDescriptor(commandId: string) {
      return rootRuntime.commands.getDescriptor(
        resolveLookupId(packageId, commandId, (entryId) => rootRuntime.commands.has(entryId))
      );
    },
    list() {
      return rootRuntime.commands.list();
    },
    onChange(listener) {
      return rootRuntime.commands.onChange(listener);
    }
  };

  const contributions: ContributionRegistry = {
    register(contribution: UIContribution) {
      const scopedContribution = scopeToolbarContributionCommandIds(rootRuntime, packageId, {
        ...contribution,
        id: scopeId(packageId, contribution.id),
        ...(contribution.slot === "footer" && contribution.beforeId
          ? {
              beforeId: resolveLookupId(
                packageId,
                contribution.beforeId,
                (entryId) => rootRuntime.contributions.has(entryId)
              )
            }
          : {})
      });
      return rootRuntime.contributions.register(scopedContribution);
    },
    unregister(id: string): void {
      rootRuntime.contributions.unregister(
        resolveLookupId(packageId, id, (entryId) => rootRuntime.contributions.has(entryId))
      );
    },
    has(id: string): boolean {
      return rootRuntime.contributions.has(
        resolveLookupId(packageId, id, (entryId) => rootRuntime.contributions.has(entryId))
      );
    },
    get(id: string) {
      return rootRuntime.contributions.get(
        resolveLookupId(packageId, id, (entryId) => rootRuntime.contributions.has(entryId))
      );
    },
    query(slot) {
      return rootRuntime.contributions.query(slot);
    },
    onChange(listener) {
      return rootRuntime.contributions.onChange(listener);
    }
  };

  const keybindings: KeybindingRegistry = {
    register(binding: KeybindingDescriptor) {
      return rootRuntime.keybindings.register({
        ...binding,
        commandId: resolveCommandReference(rootRuntime, packageId, binding.commandId)
      });
    },
    getBindingsForCommand(commandId: string) {
      const resolved = resolveLookupId(packageId, commandId, (entryId) => rootRuntime.commands.has(entryId));
      return rootRuntime.keybindings.getBindingsForCommand(resolved);
    },
    getBindingForKey(key, context) {
      return rootRuntime.keybindings.getBindingForKey(key, context);
    },
    list() {
      return rootRuntime.keybindings.list();
    }
  };

  const services: ServiceRegistryLike = {
    registerService<T>(definition: ServiceDefinition<T>): void {
      rootRuntime.services.registerService({ ...definition, id: scopeId(packageId, definition.id) });
    },
    unregister(id: string): void {
      const resolvedId = resolveLookupId(packageId, id, (entryId) => rootRuntime.services.has(entryId));
      rootRuntime.services.unregister(resolvedId);
    },
    has(id: string): boolean {
      return rootRuntime.services.has(resolveLookupId(packageId, id, (entryId) => rootRuntime.services.has(entryId)));
    },
    get(id: string) {
      return rootRuntime.services.get(resolveLookupId(packageId, id, (entryId) => rootRuntime.services.has(entryId)));
    },
    list() {
      return rootRuntime.services.list();
    },
    getService<T>(id: string): T {
      const resolvedId = resolveLookupId(packageId, id, (entryId) => rootRuntime.services.has(entryId));
      return rootRuntime.services.getService<T>(resolvedId);
    }
  };

  const dispatchers: DispatcherRegistryLike = {
    registerDispatcher(definition: DispatcherDefinition): void {
      const dispatcher = definition.dispatcher as Dispatcher & { id: string; transportId: string };
      const scopedDispatcherId = scopeId(packageId, definition.id);
      dispatcher.id = scopedDispatcherId;
      dispatcher.transportId = scopeId(packageId, dispatcher.transportId);
      rootRuntime.dispatchers.registerDispatcher({
        ...definition,
        id: scopedDispatcherId,
        dispatcher
      });
    },
    unregister(id: string): void {
      rootRuntime.dispatchers.unregister(resolveLookupId(packageId, id, (entryId) => rootRuntime.dispatchers.has(entryId)));
    },
    has(id: string): boolean {
      return rootRuntime.dispatchers.has(
        resolveLookupId(packageId, id, (entryId) => rootRuntime.dispatchers.has(entryId))
      );
    },
    get(id: string) {
      return rootRuntime.dispatchers.get(resolveLookupId(packageId, id, (entryId) => rootRuntime.dispatchers.has(entryId)));
    },
    list() {
      return rootRuntime.dispatchers.list();
    }
  };

  const transports: TransportRegistryLike = {
    registerTransport(definition: TransportDefinition): void {
      const transport = definition.transport as Transport & { id: string };
      const scopedTransportId = scopeId(packageId, definition.id);
      transport.id = scopedTransportId;
      rootRuntime.transports.registerTransport({
        ...definition,
        id: scopedTransportId,
        transport
      });
    },
    unregister(id: string): void {
      rootRuntime.transports.unregister(resolveLookupId(packageId, id, (entryId) => rootRuntime.transports.has(entryId)));
    },
    has(id: string): boolean {
      return rootRuntime.transports.has(resolveLookupId(packageId, id, (entryId) => rootRuntime.transports.has(entryId)));
    },
    get(id: string) {
      return rootRuntime.transports.get(resolveLookupId(packageId, id, (entryId) => rootRuntime.transports.has(entryId)));
    },
    list() {
      return rootRuntime.transports.list();
    }
  };

  return {
    ...rootRuntime,
    packageId,
    commands,
    contributions,
    keybindings,
    services,
    dispatchers,
    transports,
    getService<T>(serviceId: string): T {
      return services.getService<T>(serviceId);
    },
    getPackageConfig<T extends Record<string, unknown>>(targetPackageId: string): T {
      return rootRuntime.getPackageConfig<T>(targetPackageId);
    },
    async setPackageConfig(targetPackageId: string, config: Record<string, unknown>): Promise<void> {
      await rootRuntime.setPackageConfig(targetPackageId, config);
    },
    async resetPackageConfig(targetPackageId: string): Promise<void> {
      await rootRuntime.resetPackageConfig(targetPackageId);
    }
  };
}

export class PackageManager {
  private readonly packageBaseConfigById = new Map<string, Record<string, unknown>>();
  private readonly packageConfigById = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly runtime: AppRuntime,
    private readonly moduleConfig: ModuleConfig
  ) {}

  getPackageConfig<T extends Record<string, unknown>>(packageId: string): T {
    return { ...(this.packageConfigById.get(packageId) ?? {}) } as T;
  }

  async setPackageConfig(packageId: string, config: Record<string, unknown>): Promise<void> {
    const base = this.packageBaseConfigById.get(packageId);
    if (!base) {
      throw new Error(`Unknown package '${packageId}'`);
    }
    const mergedConfig = mergePackageConfig(base, config);
    const override = computePackageConfigOverride(base, mergedConfig);
    this.packageConfigById.set(packageId, mergedConfig);
    if (Object.keys(override).length > 0) {
      await savePackageConfigOverride(packageId, override);
    } else {
      await resetPackageConfigOverride(packageId);
    }
    this.runtime.eventBus.emit(CORE_EVENTS.packageConfigUpdated, {
      packageId,
      config: { ...mergedConfig }
    });
  }

  async resetPackageConfig(packageId: string): Promise<void> {
    const base = this.packageBaseConfigById.get(packageId);
    if (!base) {
      throw new Error(`Unknown package '${packageId}'`);
    }
    this.packageConfigById.set(packageId, { ...base });
    await resetPackageConfigOverride(packageId);
    this.runtime.eventBus.emit(CORE_EVENTS.packageConfigUpdated, {
      packageId,
      config: { ...base }
    });
  }

  async registerPackages(catalog: PackageCatalogEntry[]): Promise<LoadedPackage[]> {
    const seen = new Set<string>();
    const loadedPackages: LoadedPackage[] = [];

    for (const entry of catalog) {
      const cockpitPackage = entry.cockpitPackage;
      if (seen.has(cockpitPackage.id)) {
        throw new Error(`Package collision: '${cockpitPackage.id}' already exists`);
      }
      seen.add(cockpitPackage.id);

      const baseConfig = { ...entry.packageConfig.values };
      const overrideConfig = await loadPackageConfigOverride(cockpitPackage.id);
      const mergedConfig = mergePackageConfig(baseConfig, overrideConfig);
      this.packageBaseConfigById.set(cockpitPackage.id, baseConfig);
      this.packageConfigById.set(cockpitPackage.id, mergedConfig);

      const scopedRuntime = createScopedRuntime(this.runtime, cockpitPackage.id);

      const enabled = isPackageEnabled(cockpitPackage, this.moduleConfig);
      const enabledModuleIds: string[] = [];
      if (enabled) {
        for (const module of cockpitPackage.modules) {
          if (!isPackageModuleEnabled(cockpitPackage, module, this.moduleConfig)) {
            continue;
          }
          await module.register(scopedRuntime);
          enabledModuleIds.push(scopeId(cockpitPackage.id, module.id));
        }
      }

      loadedPackages.push({
        id: cockpitPackage.id,
        version: cockpitPackage.version,
        enabled,
        moduleIds: enabledModuleIds,
        settingsSchema: entry.packageConfig.settings
      });
    }

    return loadedPackages.sort((left, right) => left.id.localeCompare(right.id));
  }
}

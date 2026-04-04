import type { Dispatcher } from "../../packages/core/modules/runtime/dispatcher/base/Dispatcher";
import type { Transport } from "../../packages/core/modules/runtime/transport/base/Transport";
import { CORE_EVENTS } from "../events/topics";
import { isPackageEnabled, isPackageModuleEnabled, type ModuleConfig } from "../config/moduleConfigLoader";
import {
  loadPackageConfigOverride,
  mergePackageConfig,
  resetPackageConfigOverride,
  savePackageConfigOverride
} from "../config/packageConfigLoader";
import type { AppRuntime, LoadedPackage, PackageCatalogEntry, RegistryBundle } from "../types/module";
import type { ConsoleTabDefinition, FooterItemDefinition, ModalDialogDefinition, SidebarPanelDefinition, ToolbarMenuDefinition, WorkspaceViewDefinition } from "../types/ui";
import type { DispatcherDefinition } from "../registries/dispatcherRegistry";
import type { ServiceDefinition } from "../registries/serviceRegistry";
import type { TransportDefinition } from "../registries/transportRegistry";

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

function createScopedRegistries(
  rootRuntime: AppRuntime,
  packageId: string,
  scopedRuntimeRef: () => AppRuntime
): RegistryBundle {
  const root = rootRuntime.registries;

  const wrapSidebarRender = (definition: SidebarPanelDefinition): SidebarPanelDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    render: () => definition.render(scopedRuntimeRef())
  });
  const wrapWorkspaceRender = (definition: WorkspaceViewDefinition): WorkspaceViewDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    render: () => definition.render(scopedRuntimeRef())
  });
  const wrapConsoleRender = (definition: ConsoleTabDefinition): ConsoleTabDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    render: () => definition.render(scopedRuntimeRef())
  });
  const wrapFooterRender = (definition: FooterItemDefinition): FooterItemDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    render: () => definition.render(scopedRuntimeRef())
  });
  const wrapModalRender = (definition: ModalDialogDefinition): ModalDialogDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    renderHeader: definition.renderHeader
      ? ({ close }) => definition.renderHeader!({ runtime: scopedRuntimeRef(), close })
      : undefined,
    render: ({ close }) => definition.render({ runtime: scopedRuntimeRef(), close }),
    renderFooter: definition.renderFooter
      ? ({ close }) => definition.renderFooter!({ runtime: scopedRuntimeRef(), close })
      : undefined
  });
  const wrapToolbarMenu = (definition: ToolbarMenuDefinition): ToolbarMenuDefinition => ({
    ...definition,
    id: scopeId(packageId, definition.id),
    onSelect: definition.onSelect
      ? ({ openModal }) =>
          definition.onSelect!({
            runtime: scopedRuntimeRef(),
            openModal: (modalId) => {
              const scopedModalId = scopeId(packageId, modalId);
              if (root.modalRegistry.has(scopedModalId)) {
                openModal(scopedModalId);
                return;
              }
              openModal(modalId);
            }
          })
      : undefined,
    items: (definition.items ?? []).map((item) => ({
      ...item,
      id: scopeId(packageId, item.id),
      onSelect: ({ openModal }) =>
        item.onSelect({
          runtime: scopedRuntimeRef(),
          openModal: (modalId) => {
            const scopedModalId = scopeId(packageId, modalId);
            if (root.modalRegistry.has(scopedModalId)) {
              openModal(scopedModalId);
              return;
            }
            openModal(modalId);
          }
        })
    }))
  });

  return {
    toolbarMenuRegistry: {
      registerToolbarMenu(definition: ToolbarMenuDefinition): void {
        root.toolbarMenuRegistry.registerToolbarMenu(wrapToolbarMenu(definition));
      },
      unregister(id: string): void {
        root.toolbarMenuRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.toolbarMenuRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.toolbarMenuRegistry.has(resolveLookupId(packageId, id, (entryId) => root.toolbarMenuRegistry.has(entryId)));
      },
      get(id: string): ToolbarMenuDefinition | undefined {
        return root.toolbarMenuRegistry.get(resolveLookupId(packageId, id, (entryId) => root.toolbarMenuRegistry.has(entryId)));
      },
      list(): ToolbarMenuDefinition[] {
        return root.toolbarMenuRegistry.list();
      }
    },
    sidebarPanelRegistry: {
      registerSidebarPanel(definition: SidebarPanelDefinition): void {
        root.sidebarPanelRegistry.registerSidebarPanel(wrapSidebarRender(definition));
      },
      unregister(id: string): void {
        root.sidebarPanelRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.sidebarPanelRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.sidebarPanelRegistry.has(resolveLookupId(packageId, id, (entryId) => root.sidebarPanelRegistry.has(entryId)));
      },
      get(id: string): SidebarPanelDefinition | undefined {
        return root.sidebarPanelRegistry.get(resolveLookupId(packageId, id, (entryId) => root.sidebarPanelRegistry.has(entryId)));
      },
      list(): SidebarPanelDefinition[] {
        return root.sidebarPanelRegistry.list();
      }
    },
    workspaceViewRegistry: {
      registerWorkspaceView(definition: WorkspaceViewDefinition): void {
        root.workspaceViewRegistry.registerWorkspaceView(wrapWorkspaceRender(definition));
      },
      unregister(id: string): void {
        root.workspaceViewRegistry.unregister(
          resolveLookupId(packageId, id, (entryId) => root.workspaceViewRegistry.has(entryId))
        );
      },
      has(id: string): boolean {
        return root.workspaceViewRegistry.has(resolveLookupId(packageId, id, (entryId) => root.workspaceViewRegistry.has(entryId)));
      },
      get(id: string): WorkspaceViewDefinition | undefined {
        return root.workspaceViewRegistry.get(resolveLookupId(packageId, id, (entryId) => root.workspaceViewRegistry.has(entryId)));
      },
      list(): WorkspaceViewDefinition[] {
        return root.workspaceViewRegistry.list();
      }
    },
    consoleTabRegistry: {
      registerConsoleTab(definition: ConsoleTabDefinition): void {
        root.consoleTabRegistry.registerConsoleTab(wrapConsoleRender(definition));
      },
      unregister(id: string): void {
        root.consoleTabRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.consoleTabRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.consoleTabRegistry.has(resolveLookupId(packageId, id, (entryId) => root.consoleTabRegistry.has(entryId)));
      },
      get(id: string): ConsoleTabDefinition | undefined {
        return root.consoleTabRegistry.get(resolveLookupId(packageId, id, (entryId) => root.consoleTabRegistry.has(entryId)));
      },
      list(): ConsoleTabDefinition[] {
        return root.consoleTabRegistry.list();
      }
    },
    footerItemRegistry: {
      registerFooterItem(definition: FooterItemDefinition): void {
        root.footerItemRegistry.registerFooterItem(wrapFooterRender(definition));
      },
      unregister(id: string): void {
        root.footerItemRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.footerItemRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.footerItemRegistry.has(resolveLookupId(packageId, id, (entryId) => root.footerItemRegistry.has(entryId)));
      },
      get(id: string): FooterItemDefinition | undefined {
        return root.footerItemRegistry.get(resolveLookupId(packageId, id, (entryId) => root.footerItemRegistry.has(entryId)));
      },
      list(): FooterItemDefinition[] {
        return root.footerItemRegistry.list();
      }
    },
    modalRegistry: {
      registerModalDialog(definition: ModalDialogDefinition): void {
        root.modalRegistry.registerModalDialog(wrapModalRender(definition));
      },
      unregister(id: string): void {
        root.modalRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.modalRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.modalRegistry.has(resolveLookupId(packageId, id, (entryId) => root.modalRegistry.has(entryId)));
      },
      get(id: string): ModalDialogDefinition | undefined {
        return root.modalRegistry.get(resolveLookupId(packageId, id, (entryId) => root.modalRegistry.has(entryId)));
      },
      list(): ModalDialogDefinition[] {
        return root.modalRegistry.list();
      }
    },
    serviceRegistry: {
      registerService<T>(definition: ServiceDefinition<T>): void {
        root.serviceRegistry.registerService({ ...definition, id: scopeId(packageId, definition.id) });
      },
      unregister(id: string): void {
        const resolvedId = resolveLookupId(packageId, id, (entryId) => root.serviceRegistry.has(entryId));
        root.serviceRegistry.unregister(resolvedId);
      },
      has(id: string): boolean {
        return root.serviceRegistry.has(resolveLookupId(packageId, id, (entryId) => root.serviceRegistry.has(entryId)));
      },
      get(id: string): ServiceDefinition | undefined {
        return root.serviceRegistry.get(resolveLookupId(packageId, id, (entryId) => root.serviceRegistry.has(entryId)));
      },
      list(): ServiceDefinition[] {
        return root.serviceRegistry.list();
      },
      getService<T>(id: string): T {
        const resolvedId = resolveLookupId(packageId, id, (entryId) => root.serviceRegistry.has(entryId));
        return root.serviceRegistry.getService<T>(resolvedId);
      }
    },
    dispatcherRegistry: {
      registerDispatcher(definition: DispatcherDefinition): void {
        const dispatcher = definition.dispatcher as Dispatcher & { id: string; transportId: string };
        const scopedDispatcherId = scopeId(packageId, definition.id);
        dispatcher.id = scopedDispatcherId;
        dispatcher.transportId = scopeId(packageId, dispatcher.transportId);
        root.dispatcherRegistry.registerDispatcher({
          ...definition,
          id: scopedDispatcherId,
          dispatcher
        });
      },
      unregister(id: string): void {
        root.dispatcherRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.dispatcherRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.dispatcherRegistry.has(resolveLookupId(packageId, id, (entryId) => root.dispatcherRegistry.has(entryId)));
      },
      get(id: string): DispatcherDefinition | undefined {
        return root.dispatcherRegistry.get(resolveLookupId(packageId, id, (entryId) => root.dispatcherRegistry.has(entryId)));
      },
      list(): DispatcherDefinition[] {
        return root.dispatcherRegistry.list();
      }
    },
    transportRegistry: {
      registerTransport(definition: TransportDefinition): void {
        const transport = definition.transport as Transport & { id: string };
        const scopedTransportId = scopeId(packageId, definition.id);
        transport.id = scopedTransportId;
        root.transportRegistry.registerTransport({
          ...definition,
          id: scopedTransportId,
          transport
        });
      },
      unregister(id: string): void {
        root.transportRegistry.unregister(resolveLookupId(packageId, id, (entryId) => root.transportRegistry.has(entryId)));
      },
      has(id: string): boolean {
        return root.transportRegistry.has(resolveLookupId(packageId, id, (entryId) => root.transportRegistry.has(entryId)));
      },
      get(id: string): TransportDefinition | undefined {
        return root.transportRegistry.get(resolveLookupId(packageId, id, (entryId) => root.transportRegistry.has(entryId)));
      },
      list(): TransportDefinition[] {
        return root.transportRegistry.list();
      }
    }
  };
}

function createScopedRuntime(rootRuntime: AppRuntime, packageId: string): AppRuntime {
  let scopedRuntime!: AppRuntime;
  const registries = createScopedRegistries(rootRuntime, packageId, () => scopedRuntime);
  scopedRuntime = {
    ...rootRuntime,
    packageId,
    registries,
    getService<T>(serviceId: string): T {
      return registries.serviceRegistry.getService<T>(serviceId);
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
  return scopedRuntime;
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

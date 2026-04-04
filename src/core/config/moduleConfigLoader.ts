import { parse } from "yaml";
import type { CockpitModule } from "../types/module";
import type { CockpitPackage } from "../types/module";
import { readConfig } from "../../platform/tauri/configFs";

const DEFAULT_MODULES_YAML = `packages:
  nav2:
    enabled: true
    modules:
      navigation: true
      telemetry: true
      map: true
      debug: true
`;

export interface PackageToggleConfig {
  enabled?: boolean;
  modules: Record<string, boolean>;
}

export interface ModuleConfig {
  modules: Record<string, boolean>;
  packages: Record<string, PackageToggleConfig>;
  source: "tauri-config" | "public-config" | "default";
}

interface ParsedModulesYaml {
  modules?: Record<string, unknown>;
  packages?: Record<string, unknown>;
}

function parseLegacyModulesToggle(parsed: ParsedModulesYaml): Record<string, boolean> {
  const input = parsed?.modules ?? {};
  const modules: Record<string, boolean> = {};
  Object.entries(input).forEach(([moduleId, value]) => {
    modules[moduleId] = Boolean(value);
  });
  return modules;
}

function parsePackageToggles(parsed: ParsedModulesYaml): Record<string, PackageToggleConfig> {
  const input = parsed?.packages ?? {};
  const packages: Record<string, PackageToggleConfig> = {};

  Object.entries(input).forEach(([packageId, raw]) => {
    if (typeof raw === "boolean") {
      packages[packageId] = { enabled: raw, modules: {} };
      return;
    }
    if (!raw || typeof raw !== "object") {
      packages[packageId] = { modules: {} };
      return;
    }
    const entry = raw as { enabled?: unknown; modules?: Record<string, unknown> };
    const modules: Record<string, boolean> = {};
    Object.entries(entry.modules ?? {}).forEach(([moduleId, value]) => {
      modules[moduleId] = Boolean(value);
    });
    packages[packageId] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      modules
    };
  });

  return packages;
}

function parseModulesYaml(text: string): ModuleConfig {
  const parsed = parse(text) as ParsedModulesYaml;
  return {
    modules: parseLegacyModulesToggle(parsed),
    packages: parsePackageToggles(parsed),
    source: "default"
  };
}

async function readModulesFromPublicConfig(): Promise<string | null> {
  try {
    const response = await fetch("/config/modules.yaml");
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export async function loadModuleConfig(): Promise<ModuleConfig> {
  const tauriText = await readConfig("modules.yaml");
  if (tauriText) {
    return { ...parseModulesYaml(tauriText), source: "tauri-config" };
  }

  const publicText = await readModulesFromPublicConfig();
  if (publicText) {
    return { ...parseModulesYaml(publicText), source: "public-config" };
  }

  return { ...parseModulesYaml(DEFAULT_MODULES_YAML), source: "default" };
}

export function isPackageEnabled(cockpitPackage: CockpitPackage, moduleConfig: ModuleConfig): boolean {
  const packageToggle = moduleConfig.packages[cockpitPackage.id];
  if (typeof packageToggle?.enabled === "boolean") {
    return packageToggle.enabled;
  }
  const legacyToggle = moduleConfig.modules[cockpitPackage.id];
  if (typeof legacyToggle === "boolean") {
    return legacyToggle;
  }
  return cockpitPackage.enabledByDefault;
}

export function isModuleEnabled(module: CockpitModule, moduleConfig: ModuleConfig): boolean {
  const explicit = moduleConfig.modules[module.id];
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return module.enabledByDefault;
}

export function isPackageModuleEnabled(
  cockpitPackage: CockpitPackage,
  module: CockpitModule,
  moduleConfig: ModuleConfig
): boolean {
  if (!isPackageEnabled(cockpitPackage, moduleConfig)) {
    return false;
  }
  const packageToggle = moduleConfig.packages[cockpitPackage.id];
  const packageModuleToggle = packageToggle?.modules?.[module.id];
  if (typeof packageModuleToggle === "boolean") {
    return packageModuleToggle;
  }

  const scopedLegacyToggle = moduleConfig.modules[`${cockpitPackage.id}.${module.id}`];
  if (typeof scopedLegacyToggle === "boolean") {
    return scopedLegacyToggle;
  }

  const localLegacyToggle = moduleConfig.modules[module.id];
  if (typeof localLegacyToggle === "boolean") {
    return localLegacyToggle;
  }

  return module.enabledByDefault;
}

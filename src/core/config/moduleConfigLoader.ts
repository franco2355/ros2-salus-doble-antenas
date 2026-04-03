import { parse } from "yaml";
import type { CockpitModule } from "../types/module";
import { readConfig } from "../../platform/tauri/configFs";

const DEFAULT_MODULES_YAML = `modules:
  navigation: true
  telemetry: true
  map: true
  debug: true
  settings: true
`;

export interface ModuleConfig {
  modules: Record<string, boolean>;
  source: "tauri-config" | "public-config" | "default";
}

interface ParsedModulesYaml {
  modules?: Record<string, unknown>;
}

function parseModulesYaml(text: string): Record<string, boolean> {
  const parsed = parse(text) as ParsedModulesYaml;
  const input = parsed?.modules ?? {};
  const modules: Record<string, boolean> = {};
  Object.entries(input).forEach(([moduleId, value]) => {
    modules[moduleId] = Boolean(value);
  });
  return modules;
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
    return { modules: parseModulesYaml(tauriText), source: "tauri-config" };
  }

  const publicText = await readModulesFromPublicConfig();
  if (publicText) {
    return { modules: parseModulesYaml(publicText), source: "public-config" };
  }

  return { modules: parseModulesYaml(DEFAULT_MODULES_YAML), source: "default" };
}

export function isModuleEnabled(module: CockpitModule, moduleConfig: ModuleConfig): boolean {
  const explicit = moduleConfig.modules[module.id];
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return module.enabledByDefault;
}


import { readConfig, removeConfig, writeConfig } from "../../platform/host/configFs";
import type { PackageConfigSchema, PackageSettingFieldSchema, PackageSettingFieldType, PackageSettingsSchema } from "../types/module";

export function isPackageConfigObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function isSettingFieldType(value: unknown): value is PackageSettingFieldType {
  return value === "string" || value === "number" || value === "boolean" || value === "json";
}

function normalizeSettingsField(input: unknown): PackageSettingFieldSchema | null {
  if (!isPackageConfigObject(input)) return null;
  if (typeof input.key !== "string" || input.key.trim() === "") return null;
  if (typeof input.label !== "string" || input.label.trim() === "") return null;
  if (!isSettingFieldType(input.type)) return null;
  if (input.description !== undefined && typeof input.description !== "string") return null;
  if (input.placeholder !== undefined && typeof input.placeholder !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(input, "order")) return null;

  return {
    key: input.key,
    label: input.label,
    type: input.type,
    description: input.description,
    placeholder: input.placeholder
  };
}

function normalizeSettingsSchema(input: unknown): PackageSettingsSchema | null {
  if (!isPackageConfigObject(input)) return null;
  if (input.title !== undefined && typeof input.title !== "string") return null;
  if (!Array.isArray(input.fields)) return null;

  const fields: PackageSettingFieldSchema[] = [];
  const seen = new Set<string>();
  for (const rawField of input.fields) {
    const field = normalizeSettingsField(rawField);
    if (!field) return null;
    if (seen.has(field.key)) return null;
    seen.add(field.key);
    fields.push(field);
  }

  return {
    title: input.title,
    fields
  };
}

export function normalizePackageConfigSchema(input: unknown): PackageConfigSchema | null {
  if (!isPackageConfigObject(input)) {
    return null;
  }
  if (!isPackageConfigObject(input.values)) {
    return null;
  }
  const settings = normalizeSettingsSchema(input.settings);
  if (!settings) {
    return null;
  }
  const values = { ...input.values };
  for (const field of settings.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) {
      return null;
    }
  }
  return {
    values,
    settings
  };
}

function packageOverridePath(packageId: string): string {
  return `packages/${packageId}.json`;
}

export function mergePackageConfig(
  baseConfig: Record<string, unknown>,
  overrideConfig: Record<string, unknown> | null
): Record<string, unknown> {
  return overrideConfig ? { ...baseConfig, ...overrideConfig } : { ...baseConfig };
}

export async function loadPackageConfigOverride(packageId: string): Promise<Record<string, unknown> | null> {
  const text = await readConfig(packageOverridePath(packageId));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPackageConfigObject(parsed)) return null;
    return { ...parsed };
  } catch {
    return null;
  }
}

export async function savePackageConfigOverride(packageId: string, config: Record<string, unknown>): Promise<void> {
  await writeConfig(packageOverridePath(packageId), `${JSON.stringify(config, null, 2)}\n`);
}

export async function resetPackageConfigOverride(packageId: string): Promise<void> {
  await removeConfig(packageOverridePath(packageId));
}

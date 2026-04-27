import { normalizePackageConfigSchema } from "../config/packageConfigLoader";
import type { CockpitPackage, PackageCatalogEntry } from "../types/module";

type PackageModuleExports = {
  createPackage?: () => CockpitPackage;
  default?: (() => CockpitPackage) | CockpitPackage;
};

const packageEntries = {
  ...import.meta.glob<PackageModuleExports>("../../packages/*/index.ts", { eager: true }),
  ...import.meta.glob<PackageModuleExports>("../../packages/*/index.tsx", { eager: true })
};
const packageConfigEntries = import.meta.glob("../../packages/*/config.json", { eager: true });

function packageIdFromIndexPath(path: string): string | null {
  const match = path.match(/\/packages\/([^/]+)\/index\.(ts|tsx)$/);
  return match ? match[1] : null;
}

function packageIdFromConfigPath(path: string): string | null {
  const match = path.match(/\/packages\/([^/]+)\/config\.json$/);
  return match ? match[1] : null;
}

export function buildPackageCatalog(
  indexEntries: Record<string, PackageModuleExports>,
  configEntries: Record<string, unknown>
): PackageCatalogEntry[] {
  const configByPackageId = new Map<string, unknown>();
  Object.entries(configEntries).forEach(([path, value]) => {
    const packageId = packageIdFromConfigPath(path);
    if (!packageId) return;
    const configModule = value as { default?: unknown };
    configByPackageId.set(packageId, configModule.default ?? value);
  });

  const catalog: PackageCatalogEntry[] = [];

  Object.entries(indexEntries).forEach(([path, exports]) => {
    const fromNamed = typeof exports.createPackage === "function" ? exports.createPackage() : null;
    const fromDefaultFactory = typeof exports.default === "function" ? (exports.default as () => CockpitPackage)() : null;
    const fromDefaultObject =
      exports.default && typeof exports.default === "object" ? (exports.default as CockpitPackage) : null;
    const cockpitPackage = fromNamed ?? fromDefaultFactory ?? fromDefaultObject;
    const packageId = packageIdFromIndexPath(path);

    if (!packageId || !cockpitPackage || !cockpitPackage.id || !Array.isArray(cockpitPackage.modules)) {
      console.warn(`[package-catalog] Ignored invalid package entry at ${path}`);
      return;
    }

    if (cockpitPackage.id !== packageId) {
      console.error(
        `[package-catalog] Package id mismatch at ${path}. Folder id '${packageId}' differs from package id '${cockpitPackage.id}'.`
      );
      return;
    }

    if (!configByPackageId.has(packageId)) {
      console.error(`[package-catalog] Missing required config.json for package '${packageId}'.`);
      return;
    }

    const normalizedConfig = normalizePackageConfigSchema(configByPackageId.get(packageId));
    if (!normalizedConfig) {
      console.error(
        `[package-catalog] Invalid config.json for package '${packageId}'. Expected { values, settings.fields[] } schema.`
      );
      return;
    }

    catalog.push({
      path,
      cockpitPackage,
      packageConfig: normalizedConfig
    });
  });

  return catalog.sort((left, right) => left.cockpitPackage.id.localeCompare(right.cockpitPackage.id));
}

export function getPackageCatalog(): PackageCatalogEntry[] {
  return buildPackageCatalog(packageEntries, packageConfigEntries);
}

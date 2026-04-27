import { describe, expect, it } from "vitest";
import { createContributionRegistry } from "../core/contributions/contributionRegistry";
import { isModuleEnabled, isPackageEnabled, isPackageModuleEnabled, type ModuleConfig } from "../core/config/moduleConfigLoader";
import type { CockpitModule, CockpitPackage } from "../core/types/module";

describe("contributionRegistry", () => {
  it("preserves insertion order", () => {
    const registry = createContributionRegistry();
    registry.register({ id: "z", slot: "sidebar", label: "z", render: () => null });
    registry.register({ id: "a", slot: "sidebar", label: "a", render: () => null });
    registry.register({ id: "b", slot: "sidebar", label: "b", render: () => null });

    expect(registry.query("sidebar").map((entry) => entry.id)).toEqual(["z", "a", "b"]);
  });

  it("throws on id collision", () => {
    const registry = createContributionRegistry();
    registry.register({ id: "dup", slot: "sidebar", label: "dup", render: () => null });
    expect(() =>
      registry.register({ id: "dup", slot: "sidebar", label: "other", render: () => null })
    ).toThrow("Contribution already registered");
  });

  it("supports unregister", () => {
    const registry = createContributionRegistry();
    registry.register({ id: "to-remove", slot: "sidebar", label: "remove", render: () => null });
    registry.unregister("to-remove");
    expect(registry.has("to-remove")).toBe(false);
  });
});

describe("module toggle", () => {
  it("uses modules.yaml explicit value when present", () => {
    const module: CockpitModule = {
      id: "debug",
      version: "1",
      enabledByDefault: true,
      register: () => undefined
    };
    const config: ModuleConfig = {
      source: "public-config",
      modules: { debug: false },
      packages: {}
    };
    expect(isModuleEnabled(module, config)).toBe(false);
  });

  it("falls back to module default when missing in modules.yaml", () => {
    const module: CockpitModule = {
      id: "custom",
      version: "1",
      enabledByDefault: false,
      register: () => undefined
    };
    const config: ModuleConfig = {
      source: "default",
      modules: {},
      packages: {}
    };
    expect(isModuleEnabled(module, config)).toBe(false);
  });

  it("reads package enabled flag from packages config", () => {
    const cockpitPackage: CockpitPackage = {
      id: "nav2",
      version: "1",
      enabledByDefault: true,
      modules: []
    };
    const config: ModuleConfig = {
      source: "public-config",
      modules: {},
      packages: {
        nav2: {
          enabled: false,
          modules: {}
        }
      }
    };
    expect(isPackageEnabled(cockpitPackage, config)).toBe(false);
  });

  it("reads module toggle inside package config", () => {
    const cockpitPackage: CockpitPackage = {
      id: "nav2",
      version: "1",
      enabledByDefault: true,
      modules: []
    };
    const module: CockpitModule = {
      id: "map",
      version: "1",
      enabledByDefault: true,
      register: () => undefined
    };
    const config: ModuleConfig = {
      source: "public-config",
      modules: {},
      packages: {
        nav2: {
          enabled: true,
          modules: { map: false }
        }
      }
    };
    expect(isPackageModuleEnabled(cockpitPackage, module, config)).toBe(false);
  });
});

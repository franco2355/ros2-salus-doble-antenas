import { describe, expect, it } from "vitest";
import { SidebarPanelRegistry } from "../core/registries/sidebarPanelRegistry";
import { isModuleEnabled, type ModuleConfig } from "../core/config/moduleConfigLoader";
import type { CockpitModule } from "../core/types/module";

describe("registries", () => {
  it("sorts entries by order and id", () => {
    const registry = new SidebarPanelRegistry();
    registry.registerSidebarPanel({ id: "z", label: "z", order: 20, render: () => null });
    registry.registerSidebarPanel({ id: "a", label: "a", order: 20, render: () => null });
    registry.registerSidebarPanel({ id: "b", label: "b", order: 10, render: () => null });

    expect(registry.list().map((entry) => entry.id)).toEqual(["b", "a", "z"]);
  });

  it("throws on id collision", () => {
    const registry = new SidebarPanelRegistry();
    registry.registerSidebarPanel({ id: "dup", label: "dup", render: () => null });
    expect(() =>
      registry.registerSidebarPanel({ id: "dup", label: "other", render: () => null })
    ).toThrow("Registry collision");
  });

  it("supports unregister", () => {
    const registry = new SidebarPanelRegistry();
    registry.registerSidebarPanel({ id: "to-remove", label: "remove", render: () => null });
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
      modules: { debug: false }
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
      modules: {}
    };
    expect(isModuleEnabled(module, config)).toBe(false);
  });
});


import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { readConfig, removeConfig, writeConfig } from "../platform/host/configFs";

describe("integration", () => {
  it("persists config through fallback storage", async () => {
    await writeConfig("integration.json", '{"ok":true}');
    const read = await readConfig("integration.json");
    expect(read).toBe('{"ok":true}');
  });

  it("disables package modules from modules.yaml runtime config", async () => {
    await writeConfig(
      "modules.yaml",
      "packages:\n  nav2:\n    enabled: true\n    modules:\n      map: false\n      debug: false\n      navigation: true\n      telemetry: true\n"
    );
    const runtime = await bootstrapApp();
    expect(runtime.contributions.has("nav2.workspace.map")).toBe(false);
    expect(runtime.contributions.has("nav2.sidebar.debug")).toBe(false);
    await removeConfig("modules.yaml");
  });

  it("registers global metrics footer in core and nav2 connection status badge footer", async () => {
    const runtime = await bootstrapApp();
    expect(runtime.contributions.has("core.footer.metrics")).toBe(true);
    expect(runtime.contributions.has("nav2.footer.connection")).toBe(false);
    expect(runtime.contributions.has("nav2.footer.connection-status")).toBe(true);
    expect(runtime.contributions.has("nav2.toolbar.navigation")).toBe(false);
    expect(runtime.contributions.has("nav2.sidebar.debug")).toBe(true);
    expect(runtime.contributions.has("sidebar.settings")).toBe(true);
    expect(runtime.contributions.has("nav2.toolbar.processes")).toBe(true);
    expect(runtime.contributions.has("nav2.modal.processes")).toBe(true);
    expect(runtime.commands.has("nav2.processes.openModal")).toBe(true);

    const debugSidebar = runtime.contributions.get("nav2.sidebar.debug");
    expect(debugSidebar?.slot).toBe("sidebar");
    expect(debugSidebar && "label" in debugSidebar ? debugSidebar.label : "").toBe("Debug");

    const settingsSidebar = runtime.contributions.get("sidebar.settings");
    expect(settingsSidebar?.slot).toBe("sidebar");
    expect(settingsSidebar && "label" in settingsSidebar ? settingsSidebar.label : "").toBe("Settings");

    const processesToolbar = runtime.contributions.get("nav2.toolbar.processes");
    expect(processesToolbar?.slot).toBe("toolbar");
    expect(processesToolbar && "commandId" in processesToolbar ? processesToolbar.commandId : "").toBe(
      "nav2.processes.openModal"
    );
  });

  it("loads package config from config.json and persists local overrides", async () => {
    await removeConfig("packages/nav2.json");

    const runtime1 = await bootstrapApp();
    const base = runtime1.getPackageConfig<Record<string, unknown>>("nav2");
    expect(base.ws_real_host).toBe("localhost");
    expect(base.map_default_zoom).toBe(16);

    await runtime1.setPackageConfig("nav2", {
      ...base,
      ws_real_host: "10.0.0.1",
      map_default_zoom: 15
    });

    const rawOverride = await readConfig("packages/nav2.json");
    expect(rawOverride).not.toBeNull();
    const parsedOverride = JSON.parse(rawOverride ?? "{}") as Record<string, unknown>;
    expect(parsedOverride.ws_real_host).toBe("10.0.0.1");
    expect(parsedOverride.map_default_zoom).toBe(15);
    expect(Object.prototype.hasOwnProperty.call(parsedOverride, "ws_sim_host")).toBe(false);

    const runtime2 = await bootstrapApp();
    const overridden = runtime2.getPackageConfig<Record<string, unknown>>("nav2");
    expect(overridden.ws_real_host).toBe("10.0.0.1");
    expect(overridden.map_default_zoom).toBe(15);

    await runtime2.resetPackageConfig("nav2");
    const runtime3 = await bootstrapApp();
    const restored = runtime3.getPackageConfig<Record<string, unknown>>("nav2");
    expect(restored.ws_real_host).toBe("localhost");
    expect(restored.map_default_zoom).toBe(16);

    await removeConfig("packages/nav2.json");
  });
});

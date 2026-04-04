import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { readConfig, removeConfig, writeConfig } from "../platform/tauri/configFs";

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
    expect(runtime.registries.workspaceViewRegistry.has("nav2.workspace.map")).toBe(false);
    expect(runtime.registries.toolbarMenuRegistry.has("nav2.toolbar.debug")).toBe(false);
    await removeConfig("modules.yaml");
  });

  it("loads package config from config.json and persists local overrides", async () => {
    await removeConfig("packages/nav2.json");

    const runtime1 = await bootstrapApp();
    const base = runtime1.getPackageConfig<Record<string, unknown>>("nav2");
    expect(base.ws_real_host).toBe("100.111.4.7");
    expect(base.map_default_zoom).toBe(16);

    await runtime1.setPackageConfig("nav2", {
      ...base,
      ws_real_host: "10.0.0.1",
      map_default_zoom: 15
    });

    const runtime2 = await bootstrapApp();
    const overridden = runtime2.getPackageConfig<Record<string, unknown>>("nav2");
    expect(overridden.ws_real_host).toBe("10.0.0.1");
    expect(overridden.map_default_zoom).toBe(15);

    await runtime2.resetPackageConfig("nav2");
    const runtime3 = await bootstrapApp();
    const restored = runtime3.getPackageConfig<Record<string, unknown>>("nav2");
    expect(restored.ws_real_host).toBe("100.111.4.7");
    expect(restored.map_default_zoom).toBe(16);

    await removeConfig("packages/nav2.json");
  });
});

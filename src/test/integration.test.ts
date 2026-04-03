import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { readConfig, removeConfig, writeConfig } from "../platform/tauri/configFs";

describe("integration", () => {
  it("persists config through fallback storage", async () => {
    await writeConfig("integration.json", '{"ok":true}');
    const read = await readConfig("integration.json");
    expect(read).toBe('{"ok":true}');
  });

  it("disables module from modules.yaml runtime config", async () => {
    await writeConfig(
      "modules.yaml",
      "modules:\n  map: false\n  debug: false\n  navigation: true\n  telemetry: true\n  settings: true\n"
    );
    const runtime = await bootstrapApp();
    expect(runtime.registries.workspaceViewRegistry.has("workspace.map")).toBe(false);
    expect(runtime.registries.consoleTabRegistry.has("console.events")).toBe(false);
    await removeConfig("modules.yaml");
  });
});

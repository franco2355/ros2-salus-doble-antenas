import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../app/AppShell";
import { createCommandRegistry } from "../core/commands/commandRegistry";
import { createContributionRegistry } from "../core/contributions/contributionRegistry";
import { createContainer } from "../core/di/container";
import { createEventBus } from "../core/events/eventBus";
import { createKeybindingRegistry } from "../core/keybindings/keybindingRegistry";
import { DispatcherRegistry } from "../core/registries/dispatcherRegistry";
import { ServiceRegistry } from "../core/registries/serviceRegistry";
import { TransportRegistry } from "../core/registries/transportRegistry";
import type { AppRuntime } from "../core/types/module";
import { DispatchRouter } from "../packages/core/modules/runtime/dispatcher/DispatchRouter";
import { TransportManager } from "../packages/core/modules/runtime/transport/manager/TransportManager";
import { registerCoreSettingsUi } from "../core/bootstrap/registerCoreSettingsUi";

function createRuntime(): AppRuntime {
  const commands = createCommandRegistry();
  const contributions = createContributionRegistry();
  contributions.register({
    id: "sidebar.one",
    slot: "sidebar",
    label: "One",
    render: () => <div>Sidebar One</div>
  });
  contributions.register({
    id: "workspace.one",
    slot: "workspace",
    label: "Workspace One",
    render: () => <div>Workspace One</div>
  });
  contributions.register({
    id: "console.one",
    slot: "console",
    label: "Console One",
    render: () => <div>Console One</div>
  });

  const packageConfigById = new Map<string, Record<string, unknown>>([
    [
      "nav2",
      {
        URL_CAMERA: "",
        THEME: "monokai",
        fontsize: 13,
        enabled: true
      }
    ]
  ]);

  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);
  const runtime: AppRuntime = {
    packageId: "core",
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    },
    moduleConfig: { modules: {}, packages: {}, source: "default" },
    container: createContainer(),
    eventBus: createEventBus(),
    transportManager,
    router,
    commands,
    contributions,
    keybindings: createKeybindingRegistry(),
    services: new ServiceRegistry(),
    dispatchers: new DispatcherRegistry(),
    transports: new TransportRegistry(),
    packages: [
      {
        id: "nav2",
        version: "1.0.0",
        enabled: true,
        moduleIds: [],
        settingsSchema: {
          title: "Nav2",
          fields: [
            { key: "URL_CAMERA", label: "Camera URL", type: "string" },
            { key: "THEME", label: "Theme", type: "string" },
            { key: "fontsize", label: "Font Size", type: "number" },
            { key: "enabled", label: "Enabled", type: "boolean" }
          ]
        }
      }
    ],
    getService: () => undefined as never,
    getPackageConfig: <T extends Record<string, unknown>>(packageId: string) =>
      ({ ...(packageConfigById.get(packageId) ?? {}) }) as T,
    setPackageConfig: async (packageId: string, config: Record<string, unknown>) => {
      packageConfigById.set(packageId, { ...config });
    },
    resetPackageConfig: async (packageId: string) => {
      packageConfigById.set(packageId, {
        URL_CAMERA: "",
        THEME: "monokai",
        fontsize: 13,
        enabled: true
      });
    }
  };

  registerCoreSettingsUi(runtime);
  return runtime;
}

describe("settings modal", () => {
  it("opens from sidebar panel action and renders tabs", async () => {
    const runtime = createRuntime();
    render(<AppShell runtime={runtime} />);

    fireEvent.click(screen.getByRole("button", { name: "Configuración" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(await screen.findByLabelText("Notifications Enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Global" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "nav2" })).toBeInTheDocument();
  });

  it("validates typed values and blocks save on invalid number", async () => {
    const runtime = createRuntime();
    const setConfigSpy = vi.spyOn(runtime, "setPackageConfig");
    render(<AppShell runtime={runtime} />);

    fireEvent.click(screen.getByRole("button", { name: "Configuración" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "nav2" }));

    const fontsizeInput = screen.getByLabelText("Font Size");
    fireEvent.change(fontsizeInput, { target: { value: "bad-number" } });

    expect(await screen.findByText("Expected a valid number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(fontsizeInput, { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setConfigSpy).toHaveBeenCalled();
  });

  it("saves global settings without calling package config APIs", async () => {
    const runtime = createRuntime();
    const setConfigSpy = vi.spyOn(runtime, "setPackageConfig");
    render(<AppShell runtime={runtime} />);

    fireEvent.click(screen.getByRole("button", { name: "Configuración" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    const enabledInput = await screen.findByLabelText("Notifications Enabled");
    fireEvent.click(enabledInput);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(setConfigSpy).not.toHaveBeenCalled();
  });
});

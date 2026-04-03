import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../app/AppShell";
import { DispatchRouter } from "../dispatcher/DispatchRouter";
import { TransportManager } from "../transport/manager/TransportManager";
import { createContainer } from "../core/di/container";
import { createEventBus } from "../core/events/eventBus";
import { createRegistries } from "../core/registries/createRegistries";
import type { AppRuntime } from "../core/types/module";

function createRuntime(): AppRuntime {
  const registries = createRegistries();
  registries.sidebarPanelRegistry.registerSidebarPanel({
    id: "sidebar.one",
    label: "One",
    render: () => <div>Sidebar One</div>
  });
  registries.workspaceViewRegistry.registerWorkspaceView({
    id: "workspace.one",
    label: "Workspace One",
    render: () => <div>Workspace One</div>
  });
  registries.consoleTabRegistry.registerConsoleTab({
    id: "console.one",
    label: "Console One",
    render: () => <div>Console One</div>
  });
  registries.modalRegistry.registerModalDialog({
    id: "modal.test",
    title: "Test Modal",
    render: () => <div>Modal Body</div>
  });
  registries.toolbarMenuRegistry.registerToolbarMenu({
    id: "toolbar.test",
    label: "Tools",
    items: [
      {
        id: "open-modal",
        label: "Open modal",
        onSelect: ({ openModal }) => openModal("modal.test")
      }
    ]
  });

  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);
  return {
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    },
    moduleConfig: { modules: {}, source: "default" },
    container: createContainer(),
    eventBus: createEventBus(),
    transportManager,
    router,
    registries,
    getService: () => undefined as never
  };
}

describe("AppShell", () => {
  it("renders registered hosts and opens modal from toolbar menu", async () => {
    const runtime = createRuntime();
    render(<AppShell runtime={runtime} />);

    expect(screen.getByText("Sidebar One")).toBeInTheDocument();
    expect(screen.getAllByText("Workspace One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Console One").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Tools"));
    fireEvent.click(screen.getByText("Open modal"));

    expect(await screen.findByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal Body")).toBeInTheDocument();
  });
});

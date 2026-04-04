import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarHost } from "../app/layout/SidebarHost";
import { DispatchRouter } from "../dispatcher/DispatchRouter";
import { TransportManager } from "../transport/manager/TransportManager";
import { createContainer } from "../core/di/container";
import { createEventBus } from "../core/events/eventBus";
import { createRegistries } from "../core/registries/createRegistries";
import type { AppRuntime } from "../core/types/module";
import type { SidebarPanelDefinition } from "../core/types/ui";

function createRuntime(): AppRuntime {
  const registries = createRegistries();
  const transportManager = new TransportManager();
  return {
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
    router: new DispatchRouter(transportManager),
    registries,
    packages: [],
    getService: () => undefined as never,
    getPackageConfig: <T extends Record<string, unknown>>() => ({}) as T,
    setPackageConfig: async () => undefined,
    resetPackageConfig: async () => undefined
  };
}

describe("SidebarHost", () => {
  it("does not auto-collapse panel-card sections via implicit host logic", () => {
    const runtime = createRuntime();
    const panel: SidebarPanelDefinition = {
      id: "sidebar.test",
      label: "Test",
      render: () => (
        <div className="panel-card">
          <h3>Legacy Heading</h3>
          <p>Legacy body</p>
        </div>
      )
    };
    render(<SidebarHost runtime={runtime} panel={panel} />);

    expect(screen.getByText("Legacy body")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Legacy Heading"));
    expect(screen.getByText("Legacy body")).toBeInTheDocument();
  });
});

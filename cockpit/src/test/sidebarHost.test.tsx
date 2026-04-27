import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SidebarContribution } from "../core/contributions/types";
import { Panel } from "../packages/core";

describe("Panel", () => {
  it("does not auto-collapse panel-card sections via implicit host logic", () => {
    const panel: SidebarContribution = {
      id: "sidebar.test",
      slot: "sidebar",
      label: "Test",
      render: () => (
        <div className="panel-card">
          <h3>Legacy Heading</h3>
          <p>Legacy body</p>
        </div>
      )
    };
    render(
      <Panel
        panels={[panel]}
        activePanelId="sidebar.test"
        onSelectPanel={() => {}}
        collapsed={false}
        onToggleCollapse={() => {}}
        width={320}
        onResizeStart={() => {}}
      />
    );

    expect(screen.getByText("Legacy body")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Legacy Heading"));
    expect(screen.getByText("Legacy body")).toBeInTheDocument();
  });
});

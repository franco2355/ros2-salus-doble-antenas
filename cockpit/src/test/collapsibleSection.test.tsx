import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanelCollapsibleSection } from "../packages/core";

describe("PanelCollapsibleSection", () => {
  it("renders expanded by default and toggles on click", () => {
    render(
      <PanelCollapsibleSection title="Navigation">
        <p>Body content</p>
      </PanelCollapsibleSection>
    );

    const header = screen.getByRole("button", { name: "Navigation" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Body content")).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Body content")).not.toBeInTheDocument();
  });

  it("supports keyboard toggle with Enter and Space", () => {
    render(
      <PanelCollapsibleSection title="Camera PTZ" defaultCollapsed>
        <p>PTZ body</p>
      </PanelCollapsibleSection>
    );

    const header = screen.getByRole("button", { name: "Camera PTZ" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("PTZ body")).not.toBeInTheDocument();

    fireEvent.keyDown(header, { key: "Enter" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("PTZ body")).toBeInTheDocument();

    fireEvent.keyDown(header, { key: " " });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("PTZ body")).not.toBeInTheDocument();
  });
});

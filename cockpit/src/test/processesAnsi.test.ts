import { describe, expect, it } from "vitest";
import { parseAnsiText, stripAnsi } from "../packages/nav2/modules/processes/frontend/ansi";

describe("process ansi parser", () => {
  it("keeps plain text intact", () => {
    const parsed = parseAnsiText("healthcheck ok\n");

    expect(parsed.plainText).toBe("healthcheck ok\n");
    expect(parsed.segments).toEqual([
      {
        text: "healthcheck ok\n",
        style: {
          backgroundColor: undefined,
          color: undefined,
          fontWeight: undefined
        }
      }
    ]);
  });

  it("parses basic colors and reset", () => {
    const parsed = parseAnsiText("\u001b[31mfail\u001b[0m ok");

    expect(parsed.plainText).toBe("fail ok");
    expect(parsed.segments[0]).toEqual(
      expect.objectContaining({
        text: "fail",
        style: expect.objectContaining({
          color: "#cf222e"
        })
      })
    );
    expect(parsed.segments[1]).toEqual(
      expect.objectContaining({
        text: " ok",
        style: expect.objectContaining({
          color: undefined
        })
      })
    );
  });

  it("parses 256 palette", () => {
    const parsed = parseAnsiText("\u001b[38;5;196malert");

    expect(parsed.segments[0]?.style).toEqual(
      expect.objectContaining({
        color: "rgb(255, 0, 0)"
      })
    );
  });

  it("parses truecolor", () => {
    const parsed = parseAnsiText("\u001b[38;2;12;34;56mcustom");

    expect(parsed.segments[0]?.style).toEqual(
      expect.objectContaining({
        color: "rgb(12, 34, 56)"
      })
    );
  });

  it("ignores unsupported control sequences", () => {
    const parsed = parseAnsiText("start\u001b[2Kdone");

    expect(parsed.plainText).toBe("startdone");
    expect(parsed.segments.map((segment) => segment.text).join("")).toBe("startdone");
  });

  it("strips ansi escapes from clipboard text", () => {
    expect(stripAnsi("\u001b[31mwarning\u001b[0m\n")).toBe("warning\n");
  });
});

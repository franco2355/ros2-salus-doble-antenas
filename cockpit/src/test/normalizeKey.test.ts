import { describe, expect, it } from "vitest";
import { normalizeKeyCombo } from "../core/keybindings/normalizeKey";

describe("normalizeKeyCombo", () => {
  it("normalizes numpad zoom keys", () => {
    expect(normalizeKeyCombo(new KeyboardEvent("keydown", { ctrlKey: true, code: "NumpadAdd", key: "+" }))).toBe(
      "ctrl+numpadadd"
    );
    expect(
      normalizeKeyCombo(new KeyboardEvent("keydown", { ctrlKey: true, code: "NumpadSubtract", key: "-" }))
    ).toBe("ctrl+numpadsubtract");
  });
});

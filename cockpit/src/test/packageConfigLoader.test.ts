import { describe, expect, it } from "vitest";
import { mergePackageConfig, normalizePackageConfigSchema } from "../core/config/packageConfigLoader";

describe("package config loader", () => {
  it("normalizes config schema and rejects invalid inputs", () => {
    expect(
      normalizePackageConfigSchema({
        values: { ok: true },
        settings: {
          fields: [{ key: "ok", label: "Ok", type: "boolean" }]
        }
      })
    ).toEqual({
      values: { ok: true },
      settings: {
        title: undefined,
        fields: [{ key: "ok", label: "Ok", type: "boolean", description: undefined, placeholder: undefined }]
      }
    });
    expect(normalizePackageConfigSchema(["x"])).toBeNull();
    expect(normalizePackageConfigSchema("x")).toBeNull();
    expect(
      normalizePackageConfigSchema({
        values: { ok: true },
        settings: {
          fields: [{ key: "missing", label: "Missing", type: "boolean" }]
        }
      })
    ).toBeNull();
    expect(
      normalizePackageConfigSchema({
        values: { ok: true },
        settings: {
          fields: [{ key: "ok", label: "Ok", type: "boolean", order: 10 }]
        }
      })
    ).toBeNull();
  });

  it("merges override over base using shallow merge", () => {
    const merged = mergePackageConfig(
      {
        theme: "monokai",
        fontsize: 13,
        nested: { keep: true }
      },
      {
        fontsize: 16
      }
    );
    expect(merged).toEqual({
      theme: "monokai",
      fontsize: 16,
      nested: { keep: true }
    });
  });
});

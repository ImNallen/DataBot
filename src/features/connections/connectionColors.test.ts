import { describe, expect, it } from "vitest";
import { connectionColor, connectionColorId } from "./connectionColors";

describe("connectionColor", () => {
  it("maps a stored id to its hue", () => {
    expect(connectionColor("red")).toBe("#ef4444");
    expect(connectionColor("purple")).toBe("#a855f7");
  });

  it("reads an unknown or missing value as no color", () => {
    expect(connectionColor("teal")).toBe(null);
    expect(connectionColor("#ef4444")).toBe(null);
    expect(connectionColor(null)).toBe(null);
  });
});

describe("connectionColorId", () => {
  it("keeps a known id and drops anything else", () => {
    expect(connectionColorId("amber")).toBe("amber");
    expect(connectionColorId("teal")).toBe(null);
  });
});

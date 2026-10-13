import { describe, expect, it } from "vitest";
import { settleBridgeReply } from "./bridgeShim";

describe("settleBridgeReply", () => {
  it("resolves an ok reply to its data, like a successful invoke", () => {
    expect(settleBridgeReply(200, { status: "ok", data: { tabs: [] } })).toEqual({ tabs: [] });
    expect(settleBridgeReply(200, { status: "ok", data: null })).toBeNull();
  });

  it("throws a command error as the raw value so typedError reports it as status error", () => {
    const error = { kind: "Busy" };
    let thrown: unknown;
    try {
      settleBridgeReply(200, { status: "error", error });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(error);
    expect(thrown).not.toBeInstanceOf(Error);
  });

  it("throws a real Error for bridge failures so typedError rethrows them", () => {
    expect(() => settleBridgeReply(404, { message: "unknown command `nope`" })).toThrow(
      new Error("dev-bridge: unknown command `nope`"),
    );
    expect(() => settleBridgeReply(500, "oops")).toThrow(new Error("dev-bridge: HTTP 500"));
  });
});

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";

const BRIDGE_URL = "http://127.0.0.1:7077";

/**
 * Turns a dev-bridge HTTP reply into what Tauri's `invoke` would have produced.
 *
 * A command error is thrown as the raw value, not wrapped in an `Error`: the generated
 * `typedError` returns non-Error rejections as `{ status: "error", error }` and rethrows
 * real Errors, so bridge failures (unknown command, bad args, panics) stay loud.
 */
export function settleBridgeReply(httpStatus: number, body: unknown): unknown {
  if (httpStatus === 200 && isObject(body)) {
    if (body.status === "ok") return body.data;
    if (body.status === "error") throw body.error;
  }
  const message = isObject(body) && typeof body.message === "string" ? body.message : `HTTP ${httpStatus}`;
  throw new Error(`dev-bridge: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function installBridgeShim(): void {
  mockIPC(
    async (cmd, args) => {
      const res = await fetch(`${BRIDGE_URL}/invoke/${cmd}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
      });
      return settleBridgeReply(res.status, await res.json());
    },
    { shouldMockEvents: true },
  );
  const events = new EventSource(`${BRIDGE_URL}/events`);
  events.onmessage = (frame) => void emit("app-event", JSON.parse(frame.data));
}

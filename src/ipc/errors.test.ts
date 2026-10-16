import { expect, it } from "vitest";
import type { ApproveError, ChatError, SendError } from "./bindings";
import { approveErrorText, chatErrorText, sendErrorText } from "./errors";

it("says what to do about every way a send can fail", () => {
  const errors: SendError[] = [
    { kind: "Busy" },
    { kind: "EmptyMessage" },
    { kind: "ProviderOff", provider: "Claude" },
    { kind: "UnknownModel", model: "opus-4" },
    { kind: "AttachmentGone" },
    { kind: "Store", message: "database is locked" },
  ];
  expect(errors.map(sendErrorText)).toEqual([
    "The assistant is still answering. Stop it or wait for it to finish.",
    "Type a message first.",
    "Claude is turned off. Turn it on in Settings → Providers.",
    "The model opus-4 is no longer offered. Pick another model.",
    "The attached result is gone. Run the query again, then attach it.",
    "The chat could not be saved. database is locked",
  ]);
});

it("says why a chat could not be opened or configured, and why an approval missed", () => {
  const errors: ChatError[] = [
    { kind: "UnknownModel", model: "opus-4" },
    { kind: "UnsupportedEffort", effort: "max" },
    { kind: "Store", message: "disk full" },
  ];
  expect(errors.map(chatErrorText)).toEqual([
    "The model opus-4 is no longer offered. Pick another model.",
    "This model has no max effort level.",
    "The chat could not be saved. disk full",
  ]);
  const late: ApproveError = { kind: "NotPending" };
  expect(approveErrorText(late)).toBe("This query was already answered, stopped, or expired.");
});

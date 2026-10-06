import { describe, expect, it } from "vitest";
import { decodePairingSetupCode, encodePairingSetupCode } from "./setup-code.js";

const setupCode = encodePairingSetupCode({
  url: "wss://gateway.example/%E6%97%A5%E6%9C%AC%E8%AA%9E",
  bootstrapToken: "synthetic-bootstrap-token",
  expiresAtMs: 1,
});

describe("pairing setup payload decoding", () => {
  it.each([setupCode, `  OC-PAIR://${setupCode}\n`])(
    "recognizes encoded setup payloads even after expiry",
    (value) => {
      // Inspection may read an expired payload, but ordinary admission must reject it.
      expect(decodePairingSetupCode(value, { allowExpired: true }).bootstrapToken).toBe(
        "synthetic-bootstrap-token",
      );
      expect(() => decodePairingSetupCode(value)).toThrow("expired");
    },
  );

  it.each([
    "   ",
    "a".repeat(43), // A token is not a pairing setup payload.
    ...[
      null,
      { url: "wss://gateway.example" },
      { bootstrapToken: "fake" },
      { url: "wss://gateway.example", bootstrapToken: 1 },
      { url: "", bootstrapToken: "fake" },
      { url: "wss://gateway.example", bootstrapToken: " " },
    ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")),
  ])("rejects unrelated or malformed values", (value) => {
    expect(() => decodePairingSetupCode(value, { allowExpired: true })).toThrow();
  });
});

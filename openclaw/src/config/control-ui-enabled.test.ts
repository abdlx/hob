import { describe, expect, it } from "vitest";
import { resolveControlUiEnabled } from "./control-ui-enabled.js";

describe("headless Control UI enablement", () => {
  it.each([undefined, null, {}, { gateway: {} }, { gateway: { controlUi: {} } }])(
    "does not expose a UI for omitted enablement (%j)",
    (config) => expect(resolveControlUiEnabled(config)).toBe(false),
  );

  it.each([false, true])("preserves explicit enabled=%s", (enabled) => {
    expect(resolveControlUiEnabled({ gateway: { controlUi: { enabled } } })).toBe(enabled);
  });

  it("preserves explicit server overrides in either direction", () => {
    expect(resolveControlUiEnabled({}, true)).toBe(true);
    expect(resolveControlUiEnabled({ gateway: { controlUi: { enabled: true } } }, false)).toBe(false);
  });
});

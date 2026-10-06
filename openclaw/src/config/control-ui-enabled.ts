import type { OpenClawConfig } from "./types.openclaw.js";

/** Headless by default; explicit config or server options may host external UI assets. */
export function resolveControlUiEnabled(
  config: Pick<OpenClawConfig, "gateway"> | null | undefined,
  override?: boolean,
): boolean {
  return override ?? config?.gateway?.controlUi?.enabled ?? false;
}

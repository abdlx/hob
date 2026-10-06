// Vitest ui-isolated config runs jsdom ui tests that need a fresh module graph.
// The shared ui shard runs non-isolated for speed, but tests that spy on module
// internals and assert the component uses that spy must not share a module cache
// with stateful predecessor files (see uiIsolatedTestFiles).
import type { ViteUserConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiIsolatedVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(uiIsolatedTestFiles, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    intersectIncludeFile: true,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: "ui-isolated",
    setupFiles: ["test/helpers/plugin-lit-warnings.setup.ts"],
    useNonIsolatedRunner: false,
  });
  return config;
}

export default createUiIsolatedVitestConfig();

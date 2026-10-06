// Vitest ui config wires the ui test shard.
import type { ViteUserConfig } from "vitest/config";
import { nonBrowserTestBasenamePattern } from "./vitest.include-patterns.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";
import {
  controlUiE2eTestGlobs,
  controlUiTestGlobs,
  uiTimingTestFiles,
} from "./vitest.ui-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiVitestConfig(env?: Record<string, string | undefined>): ViteUserConfig {
  const includePatterns = [
    ...controlUiTestGlobs.filter((pattern) => !pattern.startsWith("ui/")).map((pattern) =>
      pattern.replace("*.test.ts", nonBrowserTestBasenamePattern),
    ),
  ];
  // Isolated files must never enter the shared module graph, including scoped runs.
  const exclude = [...controlUiE2eTestGlobs, ...uiIsolatedTestFiles, ...uiTimingTestFiles];
  const config = createScopedVitestConfig(includePatterns, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    exclude,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    intersectIncludeFile: true,
    isolate: false,
    name: "ui",
    setupFiles: ["test/helpers/plugin-lit-warnings.setup.ts"],
    useNonIsolatedRunner: true,
  });
  return config;
}

export default createUiVitestConfig();

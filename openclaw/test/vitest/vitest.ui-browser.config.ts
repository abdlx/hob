// Retained plugin browser tests can run independently of the bundled Control UI.
import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineProject, type ViteUserConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export function createUiBrowserVitestConfig(): ViteUserConfig {
  const root = path.resolve(import.meta.dirname, "../..");
  return defineProject({
    root,
    resolve: {
      alias: sharedVitestConfig.resolve.alias.filter(
        (alias) => alias.replacement.startsWith(path.join(root, "packages") + path.sep),
      ),
    },
    test: {
      root,
      name: "browser",
      include: ["extensions/*/browser/**/*.browser.test.ts"],
      setupFiles: ["test/helpers/plugin-lit-warnings.setup.ts"],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium", name: "chromium" }],
        headless: true,
        ui: false,
      },
    },
  });
}

export default createUiBrowserVitestConfig();

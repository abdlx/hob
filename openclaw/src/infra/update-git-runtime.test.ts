import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { collectGitRuntimeErrors, readBuiltRuntimeCommit } from "./update-git-runtime.js";

it("returns null when build provenance omits the commit", async () => {
  await withTestDir({ prefix: "openclaw-built-commit-" }, async (root) => {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.8.1" }),
    );

    expect(await readBuiltRuntimeCommit(root)).toBeNull();
  });
});

it("verifies headless runtime provenance without bundled UI and retains UI-owning checks", async () => {
  await withTestDir({ prefix: "openclaw-headless-runtime-" }, async (root) => {
    const sha = "a".repeat(40);
    const dist = path.join(root, "dist");
    await fs.mkdir(dist);
    await Promise.all([
      fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha })),
      fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
      fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
      fs.writeFile(path.join(dist, "entry.js"), "export {};\n"),
    ]);
    await expect(collectGitRuntimeErrors({ root, sha })).resolves.toEqual([]);

    // A checkout that still owns UI source must not silently waive its UI build requirement.
    await fs.mkdir(path.join(root, "ui"));
    await fs.writeFile(path.join(root, "ui", "package.json"), "{}");
    expect(await collectGitRuntimeErrors({ root, sha })).toEqual([
      expect.stringContaining("ui=missing-index"),
    ]);
  });
});

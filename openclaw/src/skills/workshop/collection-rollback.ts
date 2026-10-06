import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";

export async function restoreSkillCollectionBackupTransaction(params: {
  skillsRoot: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
  assertCommitAllowed?: () => void;
}): Promise<void> {
  const rollbackDir = path.join(params.backupDir, `.restore-${randomUUID()}`);
  try {
    params.assertCommitAllowed?.();
    await fs.mkdir(path.join(rollbackDir, "skills"), { recursive: true });
    params.assertCommitAllowed?.();
    for (const relativeDir of params.resultSkillDirs) {
      await fs.cp(
        path.join(params.skillsRoot, relativeDir),
        path.join(rollbackDir, "skills", relativeDir),
        { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
      );
      params.assertCommitAllowed?.();
    }
  } catch (error) {
    await discardRestoreSnapshot(params.backupDir, rollbackDir);
    throw error;
  }
  let discardSnapshot = false;
  try {
    await restoreSkillCollectionBackup(params);
    discardSnapshot = true;
  } catch (error) {
    try {
      // Revocation stops forward restore, never recovery of the exact pre-restore snapshot.
      await restoreSkillCollectionBackup({
        skillsRoot: params.skillsRoot,
        backupDir: rollbackDir,
        skillDirs: params.resultSkillDirs,
        resultSkillDirs: [...new Set([...params.skillDirs, ...params.resultSkillDirs])],
      });
      discardSnapshot = true;
    } catch (rollbackError) {
      const failure = new Error(
        "Skill collection restore failed and the current collection was not restored.",
        { cause: error },
      );
      Object.assign(failure, { rollbackError });
      throw failure;
    }
    throw error;
  } finally {
    if (discardSnapshot) {
      await discardRestoreSnapshot(params.backupDir, rollbackDir);
    }
  }
}

async function restoreSkillCollectionBackup(
  params: Parameters<typeof restoreSkillCollectionBackupTransaction>[0],
): Promise<void> {
  const removeDirs = new Set([
    ...params.skillDirs.map((relativeDir) => path.join(params.skillsRoot, relativeDir)),
    ...params.resultSkillDirs.map((relativeDir) => path.join(params.skillsRoot, relativeDir)),
  ]);
  for (const skillDir of [...removeDirs].toSorted((left, right) => right.length - left.length)) {
    if (await pathExists(skillDir)) {
      params.assertCommitAllowed?.();
      await removeSkillCollectionDirectory(params.skillsRoot, skillDir, params.assertCommitAllowed);
      params.assertCommitAllowed?.();
    }
  }
  for (const relativeDir of params.skillDirs) {
    params.assertCommitAllowed?.();
    await fs.mkdir(path.dirname(path.join(params.skillsRoot, relativeDir)), { recursive: true });
    params.assertCommitAllowed?.();
    await fs.cp(
      path.join(params.backupDir, "skills", relativeDir),
      path.join(params.skillsRoot, relativeDir),
      {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        filter: () => {
          params.assertCommitAllowed?.();
          return true;
        },
      },
    );
    params.assertCommitAllowed?.();
  }
}

async function discardRestoreSnapshot(backupDir: string, rollbackDir: string): Promise<void> {
  await removePathWithinRoot({
    rootDir: backupDir,
    relativePath: path.basename(rollbackDir),
    recursive: true,
    force: true,
  }).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to discard restore snapshot: ${String(error)}`);
  });
}

async function removeSkillCollectionDirectory(
  skillsRoot: string,
  skillDir: string,
  assertBeforeMutation?: () => void,
): Promise<void> {
  const relativePath = path.relative(skillsRoot, skillDir);
  if (
    !relativePath ||
    relativePath === ".." ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Skill directory must be inside the Skill Workshop directory: ${skillDir}`);
  }
  await removePathWithinRoot({
    rootDir: skillsRoot,
    relativePath,
    recursive: true,
    force: false,
    assertBeforeMutation,
  });
}

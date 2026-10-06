import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { scanSkillTrustBundle } from "./trust-scanner.js";
import type { TrustInspection, TrustWorkerOperations } from "./trust-types.js";

export class SkillTrustBlockedError extends Error {
  constructor(readonly inspection: TrustInspection) {
    super(`Skill trust ${inspection.decision}: ${inspection.objectId} revision=${inspection.revisionId} hash=${inspection.contentHash}. ${inspection.decision === "pending" ? "Inspect and approve this exact revision with openclaw skills trust." : "Activation is blocked; repair the content and verify a new revision."}`);
    this.name = "SkillTrustBlockedError";
  }
}

async function operation<K extends keyof TrustWorkerOperations>(
  type: K,
  input: TrustWorkerOperations[K]["input"],
  options: OpenClawStateDatabaseOptions,
  assertSourceCurrent?: () => void,
): Promise<TrustWorkerOperations[K]["output"]> {
  const context = captureOpenClawStateWorkerContext({ path: options.database?.path ?? options.path, env: options.env });
  const assertCurrent = retainMutationAuthority(() => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    assertSourceCurrent?.();
  });
  assertCurrent();
  const result = await runOpenClawStateWorkerOperation(context, (scope) => scope.execute({ type, input: structuredClone(input) }), {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [context.admission.databasePath]),
  });
  assertCurrent();
  return result;
}

/** Scan retained bytes. Sources, force flags, auto modes, and builtin labels grant no exemption. */
export async function verifySkillTrust(params: {
  objectId: string;
  source: string;
  files: readonly SkillLibraryFile[];
  publisher?: string;
  assertCurrent?: () => void;
  options?: OpenClawStateDatabaseOptions;
}): Promise<TrustInspection> {
  params.assertCurrent?.();
  const inspection = await operation("trust.record", {
    objectType: "skill", objectId: params.objectId, source: params.source,
    ...(params.publisher ? { publisher: params.publisher } : {}),
    ...scanSkillTrustBundle(params.files),
  }, params.options ?? {}, params.assertCurrent);
  params.assertCurrent?.();
  return inspection;
}

export async function assertSkillTrust(params: Parameters<typeof verifySkillTrust>[0]) {
  const inspection = await verifySkillTrust(params);
  if (inspection.decision !== "allow") {
    throw new SkillTrustBlockedError(inspection);
  }
  return inspection;
}

export function inspectSkillTrust(revisionId: string, options: OpenClawStateDatabaseOptions = {}, assertCurrent?: () => void) {
  return operation("trust.inspect", { revisionId }, options, assertCurrent);
}

/** Caller must be a host-authenticated human operator; never expose this as an agent tool. */
export function decideSkillTrust(input: TrustWorkerOperations["trust.decide"]["input"], options: OpenClawStateDatabaseOptions = {}, assertCurrent?: () => void) {
  return operation("trust.decide", input, options, assertCurrent);
}

import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { SKILL_TRUST_PROFILE, SKILL_TRUST_VERIFIER_VERSION } from "./trust-scanner.js";
import type { TrustInspection, TrustRevision, TrustWorkerOperations } from "./trust-types.js";

type RevisionRow = {
  revision_id: string;
  object_key: string;
  content_hash: string;
  attestation_json: string;
  verified_at_ms: number;
  previous_hash: string | null;
};
type TrustDatabase = {
  trust_objects: { object_key: string; current_revision_id: string; current_hash: string };
  trust_revisions: RevisionRow;
  trust_decisions: { decision_id: string; revision_id: string; decision: string; actor: string; decided_at_ms: number };
};
const queries = (db: DatabaseSync) => getNodeSqliteKysely<TrustDatabase>(db);
export function ensureTrustSchema(db: DatabaseSync) {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("-- Begin immutable content trust.");
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf("-- End immutable content trust.", start);
  if (start < 0 || end < start) {
    throw new Error("Canonical trust schema is missing.");
  }
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end)); // sqlite-allow-raw -- canonical feature-local DDL under worker transaction admission.
}

export function readTrustRevision(db: DatabaseSync, revisionId: string): TrustInspection | null {
  if (!tableExists(db, "trust_revisions")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(db, queries(db).selectFrom("trust_revisions").selectAll().where("revision_id", "=", revisionId));
  if (!row) {
    return null;
  }
  const attestation = JSON.parse(row.attestation_json) as TrustRevision; // Internal scanner-owned bytes; validation precedes insertion.
  validateRevision(attestation);
  const decision = executeSqliteQueryTakeFirstSync(db, queries(db).selectFrom("trust_decisions").select("decision").where("revision_id", "=", revisionId).orderBy("decided_at_ms", "desc").orderBy("decision_id", "desc"));
  return {
    ...attestation,
    revisionId: row.revision_id,
    verifiedAt: row.verified_at_ms,
    previousHash: row.previous_hash,
    decision: attestation.coverage !== "complete" || attestation.verdict === "dangerous"
      ? "quarantined"
      : decision?.decision === "reject" ? "reject"
      : attestation.verdict === "safe" || decision?.decision === "allow" ? "allow" : "pending",
  };
}

function validateRevision(input: TrustRevision) {
  if (
    input.objectType !== "skill" || !input.objectId || input.objectId.length > 2048 ||
    !input.source || input.source.length > 4096 || !/^[a-f0-9]{64}$/u.test(input.contentHash) ||
    input.profile !== SKILL_TRUST_PROFILE || input.verifierVersion !== SKILL_TRUST_VERIFIER_VERSION ||
    !["complete", "incomplete"].includes(input.coverage) ||
    !["safe", "caution", "dangerous"].includes(input.verdict) ||
    !Array.isArray(input.findings) || input.findings.length > 256 ||
    JSON.stringify(input).length > 256 * 1024
  ) {
    throw new Error("Invalid or unsupported trust attestation.");
  }
}

export function recordTrustRevision(db: DatabaseSync, input: TrustRevision): TrustInspection {
  validateRevision(input);
  const objectKey = sha256Hex(JSON.stringify([input.objectType, input.objectId, input.source]));
  const revisionId = sha256Hex(JSON.stringify([objectKey, input.contentHash, input.verifierVersion, input.profile]));
  const existing = readTrustRevision(db, revisionId);
  if (existing) {
    const row = executeSqliteQueryTakeFirstSync(db, queries(db).selectFrom("trust_revisions").select("attestation_json").where("revision_id", "=", revisionId))!;
    if (!isDeepStrictEqual(JSON.parse(row.attestation_json), input)) {
      throw new Error("Trust verifier produced a different attestation for the same immutable revision.");
    }
  } else {
    const previous = executeSqliteQueryTakeFirstSync(db, queries(db).selectFrom("trust_objects").select("current_hash").where("object_key", "=", objectKey));
    executeSqliteQuerySync(db, queries(db).insertInto("trust_revisions").values({
      revision_id: revisionId, object_key: objectKey, content_hash: input.contentHash,
      attestation_json: JSON.stringify(input), verified_at_ms: Date.now(), previous_hash: previous?.current_hash ?? null,
    }));
  }
  executeSqliteQuerySync(db, queries(db).insertInto("trust_objects").values({
    object_key: objectKey, current_revision_id: revisionId, current_hash: input.contentHash,
  }).onConflict((conflict) => conflict.column("object_key").doUpdateSet({ current_revision_id: revisionId, current_hash: input.contentHash })));
  return readTrustRevision(db, revisionId)!;
}

export function decideTrustRevision(db: DatabaseSync, input: TrustWorkerOperations["trust.decide"]["input"]): TrustInspection {
  const record = readTrustRevision(db, input.revisionId);
  if (!record || record.contentHash !== input.contentHash) {
    throw new Error("Trust decision must name an existing exact content revision.");
  }
  if (!input.actor || input.actor.length > 256 || !["allow", "reject"].includes(input.decision)) {
    throw new Error("Invalid trust decision.");
  }
  if (record.decision === "quarantined" && input.decision === "allow") {
    throw new Error("Dangerous or incompletely inspected content cannot be approved.");
  }
  const latest = executeSqliteQueryTakeFirstSync(db, queries(db).selectFrom("trust_decisions").select("decided_at_ms").where("revision_id", "=", input.revisionId).orderBy("decided_at_ms", "desc"));
  const time = Math.max(Date.now(), (latest?.decided_at_ms ?? 0) + 1);
  executeSqliteQuerySync(db, queries(db).insertInto("trust_decisions").values({
    decision_id: sha256Hex(JSON.stringify([input.revisionId, time, input.actor, input.decision])),
    revision_id: input.revisionId, decision: input.decision, actor: input.actor, decided_at_ms: time,
  }));
  return readTrustRevision(db, input.revisionId)!;
}

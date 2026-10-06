import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationContext, WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { decideTrustRevision, ensureTrustSchema, readTrustRevision, recordTrustRevision } from "./trust-store.kernel.js";
import type { TrustRevision, TrustWorkerOperations } from "./trust-types.js";

const admit = (stage: "transaction" | "commit") => requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
function transaction<Input, Output>(label: string, action: (db: ReturnType<WorkerOperationContext["open"]>["db"], input: Input) => Output) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      admit("transaction");
      ensureTrustSchema(db);
      const result = action(db, input);
      admit("commit");
      return result;
    }, { database: open(), ...stateOptions() }, { operationLabel: label });
}
export const trustOperations = {
  "trust.record": transaction("trust.record", (db, input: TrustRevision) => recordTrustRevision(db, input)),
  "trust.decide": transaction("trust.decide", (db, input: TrustWorkerOperations["trust.decide"]["input"]) => decideTrustRevision(db, input)),
  "trust.inspect": (input: { revisionId: string }, { open }: WorkerOperationContext) => readTrustRevision(open().db, input.revisionId),
} satisfies WorkerOperationHandlers;

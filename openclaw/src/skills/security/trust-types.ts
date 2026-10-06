/** Trust describes inspected content, independently of permissions and action approval. */
export type TrustVerdict = "safe" | "caution" | "dangerous";
export type TrustedObjectType =
  | "skill"
  | "plugin"
  | "mcp-server"
  | "tool-package"
  | "execution-provider"
  | "executable"
  | "repository"
  | "remote-integration";
export type TrustFinding = {
  ruleId: string;
  verdict: Exclude<TrustVerdict, "safe">;
  file: string;
  line: number;
  evidence: string;
};
export type TrustRevision = {
  objectId: string;
  objectType: TrustedObjectType;
  source: string;
  contentHash: string;
  publisher?: string;
  verifierVersion: string;
  profile: string;
  coverage: "complete" | "incomplete";
  verdict: TrustVerdict;
  findings: TrustFinding[];
  metadata: Record<string, unknown>;
};
export type TrustInspection = TrustRevision & {
  revisionId: string;
  verifiedAt: number;
  previousHash: string | null;
  decision: "allow" | "pending" | "reject" | "quarantined";
};
export type TrustWorkerOperations = {
  "trust.record": { input: TrustRevision; output: TrustInspection };
  "trust.inspect": { input: { revisionId: string }; output: TrustInspection | null };
  "trust.decide": {
    input: { revisionId: string; contentHash: string; decision: "allow" | "reject"; actor: string };
    output: TrustInspection;
  };
};

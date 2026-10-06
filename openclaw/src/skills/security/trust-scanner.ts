import path from "node:path";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { prepareSkillBundle } from "../library/bundle.js";
import { formatScanEvidence } from "./scan-evidence.js";
import { isScannable, scanSkillContent, scanSource } from "./scanner.js";
import type { TrustFinding, TrustRevision, TrustVerdict } from "./trust-types.js";

export const SKILL_TRUST_VERIFIER_VERSION = "openclaw.skill-content.v1";
export const SKILL_TRUST_PROFILE = "portable-skill-bundle.v1";
const textExtensions = new Set([
  ".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".xml", ".csv", ".html", ".css", ".svg", ".py", ".sh", ".bash", ".zsh",
  ".fish", ".ps1", ".bat", ".cmd", ".rb", ".pl", ".go", ".rs", ".sql",
]);
const inertBinaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);
type Rule = { id: string; verdict: "caution" | "dangerous"; pattern: RegExp };
// Inspect all textual instructions and support files. These are heuristics, not malware proof.
const rules: Rule[] = [
  { id: "shell-fetch-execute", verdict: "dangerous", pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d*)\b/iu },
  { id: "destructive-root", verdict: "dangerous", pattern: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+){1,3}(?:\/\s|\/\*|~\/\*|\$HOME\b)/iu },
  { id: "credential-exfiltration", verdict: "dangerous", pattern: /(?:\.ssh|\.aws|credentials|private[_ -]?key|API[_ -]?KEY)[^\n]{0,240}(?:curl[^\n]*(?:-d|--data)|requests\.post|fetch\s*\(|https?:\/\/)/iu },
  { id: "credential-exfiltration-reverse", verdict: "dangerous", pattern: /(?:curl[^\n]*(?:-d|--data)|requests\.post|fetch\s*\()[^\n]{0,240}(?:\.ssh|\.aws|credentials|private[_ -]?key|API[_ -]?KEY)/iu },
  { id: "python-shell", verdict: "caution", pattern: /\b(?:subprocess\.(?:run|Popen|call|check_output)|os\.(?:system|popen)|eval|exec)\s*\(/u },
  { id: "shell-security-change", verdict: "caution", pattern: /\b(?:sudo|chmod\s+777|Set-MpPreference|Disable-\w+Firewall|iptables\s+-F)\b/iu },
  { id: "credential-read", verdict: "caution", pattern: /(?:\.ssh\/(?:id_|config)|\.aws\/credentials|\.env\b|os\.environ|process\.env)/u },
  { id: "instruction-override", verdict: "caution", pattern: /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|safety)\s+(?:instructions|rules|prompts|checks)/iu },
  { id: "hidden-instruction", verdict: "caution", pattern: /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u },
];

export function scanSkillTrustBundle(
  files: readonly SkillLibraryFile[],
): Pick<TrustRevision, "contentHash" | "verifierVersion" | "profile" | "coverage" | "verdict" | "findings" | "metadata"> {
  // A malformed/oversized/undecodable bundle throws. It never yields a safe attestation.
  const bundle = prepareSkillBundle(files);
  const findings: TrustFinding[] = [];
  let complete = true;
  let textFiles = 0;
  let assetFiles = 0;
  const add = (ruleId: string, verdict: "caution" | "dangerous", file: string, line: number, evidence: string) => {
    if (findings.length >= 256) {
      complete = false;
      return;
    }
    findings.push({ ruleId, verdict, file, line, evidence: formatScanEvidence(evidence) });
  };
  for (const file of bundle.files) {
    const extension = path.posix.extname(file.path).toLowerCase();
    const text = file.bytes.toString("utf8");
    const decodable = Buffer.from(text).equals(file.bytes) && !text.includes("\0");
    const recognizedText = textExtensions.has(extension) || isScannable(file.path) || text.startsWith("#!") || extension === "";
    if (!decodable || !recognizedText) {
      if (!file.executable && inertBinaryExtensions.has(extension)) {
        assetFiles += 1;
        continue;
      }
      complete = false;
      add("unsupported-content", "caution", file.path, 1, "Content is outside the text/asset scanner profile.");
      continue;
    }
    textFiles += 1;
    const existing = [
      ...scanSkillContent(text, file.path),
      ...(isScannable(file.path) ? scanSource(text, file.path) : []),
    ];
    for (const finding of existing) {
      if (finding.severity === "info") {
        continue;
      }
      // Execution and dynamic code are capabilities requiring review, not proof of malware.
      const capability = ["dangerous-exec", "dynamic-code-execution"].includes(finding.ruleId);
      add(finding.ruleId, finding.severity === "critical" && !capability ? "dangerous" : "caution", file.path, finding.line, finding.evidence);
    }
    for (const [index, line] of text.split("\n").entries()) {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          add(rule.id, rule.verdict, file.path, index + 1, line);
        }
      }
    }
  }
  const verdict: TrustVerdict = findings.some((finding) => finding.verdict === "dangerous")
    ? "dangerous"
    : findings.length > 0 ? "caution" : "safe";
  return {
    contentHash: bundle.revision,
    verifierVersion: SKILL_TRUST_VERIFIER_VERSION,
    profile: SKILL_TRUST_PROFILE,
    coverage: complete ? "complete" : "incomplete",
    verdict,
    findings,
    metadata: { files: bundle.files.length, textFiles, assetFiles, excludedDirectories: [".git", "node_modules"], heuristic: true },
  };
}

export const learningControls = [
  { id: 'memoryEnabled', label: 'Built-in task memory', hint: 'Allow the native MEMORY.md store in this bot’s context and memory tools.' },
  { id: 'userProfileEnabled', label: 'Built-in user-profile memory', hint: 'Allow the native USER.md store independently of task memory.' },
  { id: 'memoryApproval', label: 'Approval for built-in memory writes', hint: 'On: native foreground writes request approval and background-review writes are staged. Off: those writes may apply directly.' },
  { id: 'skillApproval', label: 'Approval for agent skill writes', hint: 'On: native skill mutations are staged for review. Off: agent skill writes may apply directly. Operator edits remain direct.' },
  { id: 'backgroundReview', label: 'Background experience review', hint: 'Allow native autonomous review of completed work. Disabling this does not disable foreground memory or skill tools.' },
] as const;
export type LearningId = typeof learningControls[number]['id'];
export type LearningStatus = { controls: Record<LearningId, { value: boolean | null; source: 'saved' | 'default' | 'invalid' }> };
export type LearningDraft = Partial<Record<LearningId, boolean>>;

export function learningEdits(status: LearningStatus, draft: LearningDraft): LearningDraft {
  const allowed = new Set<string>(learningControls.map(control => control.id));
  const changes: LearningDraft = {};
  for (const [key, value] of Object.entries(draft)) {
    if (!allowed.has(key) || typeof value !== 'boolean') throw new Error('Choose an explicit value for a known learning setting.');
    const id = key as LearningId;
    if (status.controls[id].value !== value) changes[id] = value;
  }
  return changes;
}

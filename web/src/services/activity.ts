import type { ActivityFeed, TaskItem } from '../types/chat.ts';

export function activityFeed(value: TaskItem[] | ActivityFeed): ActivityFeed {
  if (Array.isArray(value)) return { items: value, warnings: [] };
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')) throw new Error('Activity returned an invalid feed.');
  return value;
}

export function activityNeedsAttention(item: TaskItem): boolean {
  if (item.status !== 'failed' && item.status !== 'interrupted') return false;
  const origin = item.origin;
  return !(origin?.kind === 'scheduled-job' && origin.historical === true && origin.jobState === 'deleted' && origin.inventoryStatus === 'verified' && origin.jobId);
}

export function activityOriginLabel(item: TaskItem): string {
  const origin = item.origin;
  if (!origin) return '';
  if (origin.kind === 'relay') return 'Bot handoff';
  if (origin.kind === 'group') return 'Group conversation';
  if (origin.kind !== 'scheduled-job') return '';
  const prefix = origin.historical ? 'Historical run' : 'Scheduled run';
  const state = origin.jobState === 'deleted' && origin.inventoryStatus === 'verified' && origin.jobId ? 'Job deleted'
    : origin.jobState === 'present' && origin.inventoryStatus === 'verified' ? 'Job exists'
    : origin.jobState === 'unlinked' ? 'Unlinked historical entry' : 'Job status unavailable';
  return `${prefix} · ${state}`;
}

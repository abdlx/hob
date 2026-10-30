import path from 'node:path';
import { HermesError } from './hermes-client.mjs';

export const TASK_FORMAT = 'TASK <id> — <short title>\nOUTCOME: <what done looks like, verifiable>\nCONSTRAINTS: <must not do / must respect>\nOUTPUT: <path in shared docs, or per-bot path if scratch>\nDEADLINE: <date/time, or "none">\nCORE REFS: <relevant core lines or "none">';
export const REPLY_FORMAT = 'TASK <id> — <DONE | BLOCKED | PARTIAL>\nRESULT: <what was done, in plain words>\nFILES: <paths created or changed, or "none">\nVERIFICATION: <how it checked its own result>\nBLOCKERS: <what stopped it, or "none">\nPROMOTE: <facts proposed for core, one per line with evidence, or "none">';

const invalid = () => new HermesError(400, 'Use the exact employee-team TASK header and required fields; indent continuation lines by two spaces.', 'TEAM_TASK_FORMAT');
function parse(text, fields) {
  if (typeof text !== 'string' || text.length > 64000) throw invalid();
  const [header, ...lines] = text.trim().replace(/\r\n/g, '\n').split('\n');
  const match = /^TASK ([A-Za-z0-9_-]{1,64}) — (\S.{0,199})$/.exec(header);
  if (!match) throw invalid();
  const values = {}; let previous;
  for (const line of lines) {
    if (/^ {2}\S/.test(line) || /^ {2,}$/.test(line)) {
      if (!previous) throw invalid();
      values[previous] += '\n' + line.slice(2); continue;
    }
    const field = /^([A-Z ]+): (\S.*)$/.exec(line);
    if (!field || !fields.includes(field[1]) || Object.hasOwn(values, field[1])) throw invalid();
    previous = field[1]; values[previous] = field[2].trim();
  }
  if (Object.keys(values).join('|') !== fields.join('|')) throw invalid();
  return { id: match[1], title: match[2], fields: values };
}
export function parseTeamTask(text) {
  const task = parse(text, ['OUTCOME', 'CONSTRAINTS', 'OUTPUT', 'DEADLINE', 'CORE REFS']);
  const output = task.fields.OUTPUT;
  if (output !== 'none' && (path.isAbsolute(output) || /^[a-z]:/i.test(output) || output.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || /[\x00-\x1f]/.test(output))) throw invalid();
  const deadline = task.fields.DEADLINE;
  if (deadline !== 'none' && (!/(?:Z|[+-]\d\d:\d\d)$/.test(deadline) || !Number.isFinite(Date.parse(deadline)))) throw invalid();
  return task;
}
export function parseTeamReply(text, taskId) {
  const reply = parse(text, ['RESULT', 'FILES', 'VERIFICATION', 'BLOCKERS', 'PROMOTE']);
  if (reply.id !== taskId || !['DONE', 'BLOCKED', 'PARTIAL'].includes(reply.title)) throw invalid();
  return reply;
}

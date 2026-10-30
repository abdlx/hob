import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HermesError, hermesProfile } from './hermes-client.mjs';
import { containsTeamCredentials, teamDirectory } from './hermes-team.mjs';
import { parseTeamReply, parseTeamTask } from './hermes-team-protocol.mjs';
import { readObservedFile } from './bounded-file.mjs';

const MAX = 25 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const refuse = (message = 'Only the assigned, non-sensitive worker output can be handed to the coordinator.', status = 400, code = 'TEAM_ARTIFACT_REFUSED') => new HermesError(status, message, code);
const privatePath = /(?:^|\/)(?:\.[^/]*|memories|credentials?|secrets?|auth(?:\.json)?|AGENTS\.md|SOUL\.md|USER\.md|MEMORY\.md|TEAM_CORE\.md|config\.ya?ml|state\.db)(?:\/|$)|\.(?:pem|key|sqlite|db)$/i;

function outputParts(output) {
  if (typeof output !== 'string' || output === 'none' || output.length > 4096 || /^[a-z]:/i.test(output) || path.isAbsolute(output) || /[\x00-\x1f\x7f%:]/.test(output)) throw refuse();
  const parts = output.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..') || privatePath.test(parts.join('/'))) throw refuse();
  return parts;
}

function namesOutput(files, output) {
  if (files.trim() === output) return true;
  try { const paths = JSON.parse(files); if (Array.isArray(paths) && paths.includes(output)) return true; } catch { /* Plain path lists are also valid reply prose. */ }
  return files.split(/[\n,]/).map(item => item.trim().replace(/^-\s*/, '').replace(/^`(.*)`$/, '$1')).includes(output);
}

async function readPinned(root, parts) {
  const folder = await teamDirectory(root, parts.slice(0, -1));
  try {
    const filename = path.join(folder.target, parts.at(-1));
    const entry = await lstat(filename, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size > BigInt(MAX)) throw refuse();
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) throw refuse();
      const bytes = await readObservedFile(handle, Number(before.size));
      const after = await handle.stat({ bigint: true });
      if (bytes.length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) throw refuse('The output changed during handoff. Retry after the worker finishes writing.', 409);
      return { bytes, sha256: sha(bytes), modifiedAt: new Date(Number(before.mtimeMs)).toISOString() };
    } finally { await handle.close(); }
  } finally { await folder.close(); }
}

/** One immutable nominated snapshot, with a separate coordinator-authored review. */
export function createTeamArtifactHandoffs({ team, workspaceRoot, roster }) {
  const queues = new Map();
  function authorize(record) {
    if (!team?.policy().coordinatorOnly || record?.teamControlled !== true || record.from !== 'default' || record.to === 'default' || record.status !== 'completed'
      || record.replyTruncated || !/^[a-f0-9-]{36}$/.test(record.id || '')) throw refuse('This exchange has no completed coordinator-assigned output handoff.', 409);
    hermesProfile(record.to);
    if (!['default', record.to].every(name => roster().some(bot => bot.name === name && bot.state === 'active'))) throw refuse('The coordinator and worker must both be active.', 403);
    const task = parseTeamTask(record.message), reply = parseTeamReply(record.reply, task.id);
    if (task.id !== record.teamTask?.id || !['DONE', 'PARTIAL'].includes(reply.title) || !namesOutput(reply.fields.FILES, task.fields.OUTPUT)) throw refuse('The worker reply must identify the output nominated by its original assignment.', 409);
    return { task, reply, parts: outputParts(task.fields.OUTPUT) };
  }
  function serial(id, work) {
    const pending = (queues.get(id) || Promise.resolve()).catch(() => undefined).then(work);
    queues.set(id, pending);
    void pending.finally(() => { if (queues.get(id) === pending) queues.delete(id); }).catch(() => undefined);
    return pending;
  }
  function validateReceipt(record, receipt, task) {
    if (receipt.exchangeId !== record.id || receipt.worker !== record.to || receipt.taskId !== task.id || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || receipt.assignmentSha256 !== sha(record.message) || receipt.replySha256 !== sha(record.reply)
      || receipt.source !== task.fields.OUTPUT || receipt.path !== `.hob/team-inbox/${record.id}/${receipt.sha256}-${path.basename(task.fields.OUTPUT.replaceAll('\\', '/')).replace(/[^A-Za-z0-9._-]/g, '_').slice(-100)}`) throw refuse('The stored handoff does not match this assignment.', 409);
  }
  async function inspect(record) {
    const { task } = authorize(record), receipt = team.artifactHandoff(record.id);
    if (!receipt) return null;
    validateReceipt(record, receipt, task);
    const current = await readPinned(workspaceRoot, ['main', ...receipt.path.split('/')]);
    if (current.sha256 !== receipt.sha256 || current.bytes.length !== receipt.bytes) throw refuse('The coordinator output copy changed. Its previous review does not verify these bytes.', 409, 'TEAM_ARTIFACT_CHANGED');
    authorize(record);
    return { ...receipt, reviews: team.artifactReviews(record.id) };
  }
  async function receive(record) {
    return serial(record.id, async () => {
      const { task, parts } = authorize(record), previous = team.artifactHandoff(record.id);
      if (previous) {
        try { return await inspect(record); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        validateReceipt(record, previous, task);
      }
      const source = await readPinned(workspaceRoot, ['bots', record.to, ...parts]);
      if (containsTeamCredentials(source.bytes.toString('utf8'))) throw refuse('Potential credentials were detected in the nominated output. Ask for a non-sensitive deliverable.');
      if (previous && source.sha256 !== previous.sha256) throw refuse('The original snapshot is missing and the worker output changed. Delegate a new task to review new bytes.', 409);
      const name = `${source.sha256}-${parts.at(-1).replace(/[^A-Za-z0-9._-]/g, '_').slice(-100)}`;
      // In users mode, the broker's inherited ACL grants only this bot read/traverse.
      // Mode 0750/0640 keeps that named ACL effective; 0700/0600 would mask it out.
      const folder = await teamDirectory(workspaceRoot, ['main', '.hob', 'team-inbox', record.id], { create: true, mode: 0o750 });
      const temporary = path.join(folder.target, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, source.bytes, { flag: 'wx', mode: 0o640, flush: true });
        try { await link(temporary, path.join(folder.target, name)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally {
        try {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (process.platform === 'linux') {
            const directory = await open(folder.target, constants.O_RDONLY | constants.O_DIRECTORY);
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } finally { await folder.close(); }
      }
      const receipt = previous || { exchangeId: record.id, taskId: task.id, worker: record.to, source: task.fields.OUTPUT,
        assignmentSha256: sha(record.message), replySha256: sha(record.reply),
        path: `.hob/team-inbox/${record.id}/${name}`, sha256: source.sha256, bytes: source.bytes.length,
        sourceModifiedAt: source.modifiedAt, receivedAt: new Date().toISOString() };
      const copied = await readPinned(workspaceRoot, ['main', ...receipt.path.split('/')]);
      if (copied.sha256 !== receipt.sha256 || copied.bytes.length !== receipt.bytes) throw refuse('A different file occupies the coordinator handoff location.', 409);
      authorize(record);
      const saved = team.saveArtifactHandoff(record.id, receipt);
      if (saved.sha256 !== receipt.sha256) throw refuse('Another snapshot already owns this exchange.', 409);
      return { ...saved, reviews: team.artifactReviews(record.id) };
    });
  }
  async function review(record, input) {
    return serial(record.id, async () => {
      const { reply } = authorize(record);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sha256', 'verdict', 'checks', 'requestId'].includes(key))
        || !/^[a-f0-9]{64}$/.test(input.sha256 || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId || '') || !['passed', 'failed'].includes(input.verdict)
        || typeof input.checks !== 'string' || !input.checks.trim() || /^none$/i.test(input.checks.trim()) || input.checks.length > 4000 || containsTeamCredentials(input.checks)) throw refuse('Record a reviewed snapshot hash, a verdict, non-sensitive checks, and a stable request ID.');
      if (input.verdict === 'passed' && (reply.title !== 'DONE' || reply.fields.BLOCKERS.toLowerCase() !== 'none')) throw refuse('A partial or blocked worker result cannot be recorded as a passed completed task.', 409);
      const receipt = await inspect(record);
      if (!receipt || receipt.sha256 !== input.sha256) throw refuse('Fetch and inspect this exact assigned output before recording a review.', 409);
      authorize(record);
      return team.saveArtifactReview(record.id, input);
    });
  }
  function reviewState(record) {
    // This projection contains no coordinator-local path or private checks.
    // It repairs the exchange cache after a crash between the two DB commits.
    const receipt = team.artifactHandoff(record.id);
    if (!receipt) return null;
    try { validateReceipt(record, receipt, parseTeamTask(record.message)); } catch { return null; }
    const review = team.artifactReviews(record.id).find(item => item.sha256 === receipt.sha256);
    return { teamOutput: { sha256: receipt.sha256, bytes: receipt.bytes, receivedAt: receipt.receivedAt },
      ...(review ? { teamVerification: review.verdict === 'passed' ? 'coordinator-reviewed' : 'coordinator-rejected',
        teamReview: { id: review.requestId, sha256: review.sha256, verdict: review.verdict, at: review.at } } : {}) };
  }
  return { receive, inspect, review, reviewState };
}

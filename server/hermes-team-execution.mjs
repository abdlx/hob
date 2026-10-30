import { createHash, randomUUID } from 'node:crypto';
import { HermesError, hermesProfile } from './hermes-client.mjs';

const fail = (message, status = 400) => new HermesError(status, message, 'INVALID_TEAM_EXECUTION_ROUTE');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function createTeamExecutionRoutes({ db, active, sensitive, now = Date.now }) {
  const revision = () => db.prepare('SELECT revision FROM execution_policy WHERE id=1').get().revision;
  const normalize = value => {
    const keys = ['id', 'profile', 'endpoint', 'models', 'billingMode', 'credentialDigest', 'basis'];
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) throw fail('Use a concrete model route without extra fields.');
    const { id = randomUUID(), profile, endpoint, models, billingMode, credentialDigest, basis } = value;
    if (typeof id !== 'string' || !uuid.test(id) || typeof profile !== 'string' || hermesProfile(profile) !== profile) throw fail('Select a stable active bot identity.');
    active(profile);
    let url;
    try { url = new URL(endpoint); } catch { throw fail('Enter the complete model inference endpoint.'); }
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !['https:', 'http:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.hostname.endsWith('.') || /[%\\\x00-\x20]/.test(endpoint) || url.href.includes('%') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(endpoint)
      || !/(?:\/chat\/completions|\/responses|\/messages)$/.test(url.pathname)) throw fail('Use an exact HTTP inference endpoint without credentials, query, fragments or path aliases.');
    if (!['free', 'local', 'subscription'].includes(billingMode) || billingMode !== 'local' && url.protocol !== 'https:') throw fail('Only reviewed free, local or existing subscription routes with no usage charges are permitted.');
    if (!Array.isArray(models) || !models.length || models.length > 128 || models.some(model => typeof model !== 'string' || !model || model.length > 200 || /[\x00-\x20*]/.test(model)) || new Set(models).size !== models.length) throw fail('List distinct exact wire model IDs without wildcards.');
    if ((url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai')) && models.some(model => model !== 'openrouter/free' && !model.endsWith(':free'))) throw fail('OpenRouter routes may contain only free model variants.');
    if (typeof credentialDigest !== 'string' || !/^[a-f0-9]{64}$/.test(credentialDigest)) throw fail('Use the credential fingerprint reported by the native execution guard; do not paste a token.');
    if (typeof basis !== 'string' || basis.trim().length < 8 || basis.length > 4000 || sensitive(JSON.stringify(value))) throw fail('Record non-sensitive evidence that this endpoint/account has no usage or overage charges.');
    return { id, profile, endpoint: url.href, models: [...models].sort(), billingMode, credentialDigest, basis: basis.trim() };
  };
  const state = () => ({ revision: revision(), paidExecution: false, allowSubscriptions: true,
    routes: db.prepare('SELECT value,revoked FROM execution_routes ORDER BY revoked IS NULL DESC,created DESC,id LIMIT 256').all().map(row => ({ ...JSON.parse(row.value), revoked: row.revoked })) });
  const transact = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    state,
    preview(value) { const route = normalize(value); return { route, digest: digest(route), revision: revision() }; },
    approve(value) {
      if (!value || Object.keys(value).some(key => !['route', 'digest', 'revision', 'confirm', 'confirmNoUsageCharges'].includes(key)) || value.confirm !== true || value.confirmNoUsageCharges !== true) throw fail('Review this exact endpoint, model list, credential fingerprint and billing evidence, then confirm no usage or overage charges.');
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) throw fail('Use the exact reviewed route digest and execution-policy revision.');
      const route = normalize(value.route);
      if (digest(route) !== value.digest) throw fail('The route changed after review.', 409);
      transact(() => {
        if (value.revision !== revision()) throw fail('Execution routes changed; refresh and review again.', 409);
        if (db.prepare('SELECT 1 FROM execution_routes WHERE id=?').get(route.id)) throw fail('This approval ID has already been used.', 409);
        if (db.prepare('SELECT count(*) AS count FROM execution_routes WHERE revoked IS NULL').get().count >= 128) throw fail('Revoke unused routes before adding more active approvals.', 409);
        const receipt = { ...route, digest: value.digest, confirmNoUsageCharges: true, author: 'user', approvedAt: now() };
        db.prepare('INSERT INTO execution_routes VALUES (?,?,?,?,NULL)').run(route.id, route.profile, JSON.stringify(receipt), receipt.approvedAt);
        db.prepare('UPDATE execution_policy SET revision=revision+1 WHERE id=1').run();
      });
      return state();
    },
    revoke(value) {
      if (!value || Object.keys(value).some(key => !['id', 'digest', 'revision', 'confirm'].includes(key)) || value.confirm !== true) throw fail('Confirm the exact route revocation.');
      if (typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('Use the exact active route ID, digest and execution-policy revision.');
      transact(() => {
        if (value.revision !== revision()) throw fail('Execution routes changed; refresh and review again.', 409);
        const row = db.prepare('SELECT value,revoked FROM execution_routes WHERE id=?').get(value.id);
        if (!row || row.revoked !== null || JSON.parse(row.value).digest !== value.digest) throw fail('The active route changed.', 409);
        db.prepare('UPDATE execution_routes SET revoked=? WHERE id=?').run(now(), value.id);
        db.prepare('UPDATE execution_policy SET revision=revision+1 WHERE id=1').run();
      });
      return state();
    },
  };
}

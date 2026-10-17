import { HermesError } from './hermes-client.mjs';

// Native config paths only. Hermes remains the default resolver and write owner.
const controls = new Map([
  ['memoryEnabled', ['memory', 'memory_enabled']],
  ['userProfileEnabled', ['memory', 'user_profile_enabled']],
  ['memoryApproval', ['memory', 'write_approval']],
  ['skillApproval', ['skills', 'write_approval']],
  ['backgroundReview', ['auxiliary', 'background_review', 'enabled']],
]);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => {
  for (const key of path) {
    if (!record(value)) return { malformed: true };
    if (!Object.hasOwn(value, key)) return {};
    value = value[key];
  }
  return { value };
};
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');

/** Independent native learning switches; deliberately no synthetic "auto" mode. */
export async function hermesLearningSetup(method, { dashboard, input, json, res, profile }) {
  const status = async () => {
    const [effective, saved] = await Promise.all([
      dashboard('/api/config'), dashboard('/api/config', { query: { include_defaults: false } }),
    ]);
    if (!record(effective) || !record(saved)) throw new HermesError(502, 'Hermes returned invalid learning settings.', 'HERMES_PROTOCOL_ERROR');
    return { controls: Object.fromEntries([...controls].map(([id, path]) => {
      const current = at(effective, path), stored = at(saved, path);
      const malformed = current.malformed || stored.malformed || (stored.value !== undefined && typeof stored.value !== 'boolean') || typeof current.value !== 'boolean';
      return [id, { value: malformed ? null : current.value, source: malformed ? 'invalid' : stored.value === undefined ? 'default' : 'saved' }];
    })) };
  };
  if (method === 'GET') return json(res, 200, await status());
  if (method === 'PUT') {
    const value = await input(['changes', 'confirm']);
    if (value.confirm !== true) throw invalid('Confirm changes to this bot’s learning and write permissions.');
    if (!record(value.changes) || !Object.keys(value.changes).length || Object.keys(value.changes).length > controls.size) throw invalid('Choose the learning settings to change.');
    const config = {};
    for (const [id, enabled] of Object.entries(value.changes)) {
      const path = controls.get(id);
      if (!path || typeof enabled !== 'boolean') throw invalid('Use explicit booleans for known learning settings.');
      let target = config;
      for (const key of path.slice(0, -1)) target = target[key] ??= {};
      target[path.at(-1)] = enabled;
    }
    // Native ConfigUpdate gives a body profile precedence, so bind both selectors.
    await dashboard('/api/config', { method, body: { config, profile } });
    return json(res, 200, await status());
  }
  throw new HermesError(404, 'Unknown learning setup operation.', 'NOT_FOUND');
}

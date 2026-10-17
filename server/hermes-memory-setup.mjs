import { HermesError, hermesResource } from './hermes-client.mjs';
import { containsStoredSecret, redactHermesSettings } from './hermes-settings.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const protocol = () => new HermesError(502, 'Hermes returned an invalid memory-provider response.', 'HERMES_PROTOCOL_ERROR');
const text = value => typeof value === 'string' && value.length <= 64000;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const list = value => { if (value == null) return []; if (!Array.isArray(value) || value.length > 128) throw protocol(); return value; };
const nameOf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw invalid('Choose a valid memory provider.');
  return hermesResource(value);
};
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const sensitive = /(?:api[_-]?key|password|token|secret|credential|authorization|private[_-]?key)/i;
function secretValue(value) {
  if (value && typeof value === 'object') return JSON.stringify(redactHermesSettings(value)) !== JSON.stringify(value) || Object.values(value).some(secretValue);
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some(key => sensitive.test(key))) return true;
  } catch { /* Plain configuration value. */ }
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && secretValue(parsed); } catch { return false; }
}
const setupView = value => ({
  dependenciesInstalled: value?.dependencies_installed === true,
  pythonDependenciesDeclared: value?.python_dependencies_declared === true,
  pythonPackages: list(value?.pip_dependencies).filter(text),
  externalDependencies: list(value?.external_dependencies).map(item => ({ name: text(item?.name) ? item.name : 'External dependency', hasInstall: Boolean(item?.install) })),
  requiredEnv: list(value?.required_env).filter(text),
});
function fieldsView(fields) {
  if (!Array.isArray(fields) || fields.length > 128) throw protocol();
  const keys = new Set();
  return fields.map(field => {
    if (!record(field) || !text(field.key) || !field.key || field.key.length > 128 || keys.has(field.key)) throw protocol();
    keys.add(field.key);
    const hidden = field.kind === 'secret' || sensitive.test(field.key) || secretValue(field.value);
    const kind = hidden ? 'secret' : field.kind === 'bool' ? 'boolean' : field.kind;
    if (!['text', 'secret', 'select', 'boolean', 'integer', 'number', 'json'].includes(kind)) throw protocol();
    const value = hidden ? '' : field.value ?? '';
    if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw protocol();
    return {
      key: field.key, label: text(field.label) ? field.label : field.key, description: text(field.description) ? field.description : '', kind,
      ...Object.fromEntries(['minimum', 'maximum', 'step'].filter(key => Number.isFinite(field[key])).map(key => [key, field[key]])),
      placeholder: hidden || !text(field.placeholder) ? '' : field.placeholder,
      value, isSet: field.is_set === true || (hidden && Boolean(field.value)), required: field.required === true,
      options: hidden ? [] : list(field.options).map(item => {
        if (!record(item) || !text(item.value) || !text(item.label)) throw protocol();
        return { value: item.value, label: item.label };
      }),
      ...(record(field.when) ? { when: Object.fromEntries(Object.entries(field.when).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value))) } : {}),
    };
  });
}

/** Native provider configuration only: no second memory store or dependency runner. */
export async function hermesMemorySetup(route, method, { dashboard, input, json, res }) {
  const status = async () => {
    const result = await dashboard('/api/memory');
    if (!record(result) || typeof result.active !== 'string' || !Array.isArray(result.providers)) throw protocol();
    return { active: result.active, builtinFiles: Object.fromEntries(['memory', 'user'].map(key => [key,
      Number.isSafeInteger(result.builtin_files?.[key]) && result.builtin_files[key] >= 0 ? result.builtin_files[key] : 0])),
    providers: list(result.providers).map(item => {
      if (!record(item) || !text(item.name) || !text(item.description) || !text(item.status)) throw protocol();
      nameOf(item.name);
      return { name: item.name, description: item.description, available: item.available === true, configured: item.configured === true, status: item.status, setup: setupView(item.setup) };
    }) };
  };
  const schema = async name => {
    const encoded = nameOf(name);
    const declared = await dashboard(`/api/memory/providers/${encoded}/config`, { query: { surface: 'declared' } });
    if (!Array.isArray(declared?.fields)) throw protocol();
    const surface = declared.fields.length ? 'declared' : 'native';
    const result = surface === 'declared' ? declared : await dashboard(`/api/memory/providers/${encoded}/config`);
    return { name, label: text(result?.label) ? result.label : name, docs_url: text(result?.docs_url) ? result.docs_url : '', surface, fields: fieldsView(result?.fields) };
  };
  if (route === 'memory' && method === 'GET') return json(res, 200, await status());
  if (route === 'memory/provider' && method === 'PUT') {
    const value = await input(['provider', 'confirm']);
    if (value.confirm !== true) throw invalid('Confirm selecting this bot’s memory provider. External providers may receive its memory and conversations.');
    if (value.provider !== '') nameOf(value.provider);
    await dashboard('/api/memory/provider', { method, body: { provider: value.provider } });
    return json(res, 200, await status());
  }
  const match = /^memory\/providers\/([^/]+)(?:\/(setup))?$/.exec(route);
  if (match) {
    let name;
    try { name = decodeURIComponent(match[1]); } catch { throw invalid('Invalid memory provider.'); }
    const encoded = nameOf(name);
    if (!match[2] && method === 'GET') return json(res, 200, await schema(name));
    if (!match[2] && method === 'PUT') {
      const value = await input(['surface', 'values', 'confirm']);
      if (value.confirm !== true) throw invalid('Confirm saving and selecting this memory provider for the bot.');
      const current = await schema(name);
      if (value.surface !== current.surface) throw new HermesError(409, 'The provider form changed. Refresh before saving.', 'MEMORY_SCHEMA_CHANGED');
      if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values) || Object.keys(value.values).length > 128) throw invalid('Submit only edited provider fields.');
      const known = new Map(current.fields.map(field => [field.key, field]));
      for (const [key, entry] of Object.entries(value.values)) {
        const field = known.get(key);
        if (!field || !['string', 'boolean', 'number'].includes(typeof entry) || (typeof entry === 'string' && entry.length > 64000)
          || (typeof entry === 'number' && !Number.isFinite(entry)) || containsStoredSecret(entry)) throw invalid('Submit only known provider fields with explicit values; stored credentials must stay omitted.');
        if (typeof entry === 'string') {
          let parsed;
          try { parsed = JSON.parse(entry); } catch { /* Non-JSON field; native validation owns coercion. */ }
          if (containsStoredSecret(parsed)) throw invalid('Stored credential placeholders cannot be saved inside JSON fields.');
        }
        if (field.kind === 'secret' && (typeof entry !== 'string' || !entry.trim())) delete value.values[key];
        if (field.kind === 'json' && typeof entry === 'string' && entry.trim()) {
          try { const parsed = JSON.parse(entry); if (!record(parsed) && !Array.isArray(parsed)) throw new Error(); } catch { throw invalid('Enter a JSON object/array without stored credential placeholders.'); }
        }
      }
      await dashboard(`/api/memory/providers/${encoded}/config`, { method, body: { values: value.values },
        ...(current.surface === 'declared' ? { query: { surface: 'declared' } } : {}) });
      return json(res, 200, await status());
    }
    if (match[2] === 'setup' && method === 'POST') {
      const value = await input(['confirm']);
      if (value.confirm !== true) throw invalid('Confirm native provider setup. Hermes may install packages or run provider-declared setup on its host.');
      const result = await dashboard(`/api/memory/providers/${encoded}/setup`, { method, body: { values: {} }, timeoutMs: 300000 });
      // Install commands/stdout/stderr can contain credentials and are not UI data.
      return json(res, 200, { ok: result.ok === true, results: list(result.results).map(item => pick(item, ['kind', 'name', 'status', 'returncode'])),
        memory: await status() });
    }
  }
  throw new HermesError(404, 'Unknown memory setup operation.', 'NOT_FOUND');
}

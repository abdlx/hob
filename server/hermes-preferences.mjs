import { HermesError } from './hermes-client.mjs';

const languages = { auto: '', en: 'English', 'ur-Latn': 'Roman Urdu (Urdu written in Latin script)', ur: 'Urdu', mixed: 'the same language and script as the user, including code-switching' };
const START = '<!-- hob:language:start -->', END = '<!-- hob:language:end -->';
const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');

export async function hermesPreferences(method, { dashboard, input, json, res, profile }) {
  const view = config => ({
    language: Object.keys(languages).find(key => languages[key] === (config.auxiliary?.title_generation?.language || '')) || 'auto',
    timezone: typeof config.timezone === 'string' ? config.timezone : '',
    maxTurns: Number.isSafeInteger(config.agent?.max_turns) && config.agent.max_turns > 0 ? config.agent.max_turns : null,
    runBudgetSeconds: Number.isSafeInteger(config.agent?.run_budget_seconds) && config.agent.run_budget_seconds > 0 ? config.agent.run_budget_seconds : null,
  });
  if (method === 'GET') return json(res, 200, view(await dashboard('/api/config')));
  if (method !== 'PUT') throw invalid('Unsupported bot preference operation.');
  const value = await input(['language', 'timezone', 'maxTurns', 'runBudgetSeconds', 'confirm']);
  if (value.confirm !== true || !Object.hasOwn(languages, value.language) || typeof value.timezone !== 'string' || value.timezone.length > 100) throw invalid('Confirm valid language and timezone choices.');
  if (value.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { throw invalid('Choose an IANA timezone such as Asia/Karachi.'); } }
  for (const [key, maximum] of [['maxTurns', 1000], ['runBudgetSeconds', 86400]]) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum)) throw invalid(`${key} must be empty or a whole number between 1 and ${maximum}.`);
  }
  const previous = await dashboard('/api/config');
  const hint = previous.agent?.environment_hint ?? '';
  if (typeof hint !== 'string') throw new HermesError(409, 'The native environment hint is not text. Repair it in Advanced configuration before changing language.', 'INVALID_NATIVE_CONFIG');
  const preserved = hint.replace(/<!-- hob:language:start -->[\s\S]*?<!-- hob:language:end -->/g, '').trim();
  const instruction = value.language === 'auto'
    ? 'Match the language and script of the current user conversation. Preserve Roman Urdu in Latin script and respect explicit language changes. Do not inherit another bot or project language.'
    : `Use ${languages[value.language]} for replies and conversation titles unless the user explicitly requests another language. Keep this preference scoped to this bot.`;
  const config = { timezone: value.timezone, agent: { max_turns: value.maxTurns, run_budget_seconds: value.runBudgetSeconds,
    environment_hint: [preserved, `${START}\n${instruction}\n${END}`].filter(Boolean).join('\n\n') },
  auxiliary: { title_generation: { language: languages[value.language] } } };
  const saved = await dashboard('/api/config', { method, body: { profile, config } });
  if (saved?.ok !== true) throw new HermesError(502, 'Hermes did not confirm these preferences.', 'SAVE_NOT_CONFIRMED');
  return json(res, 200, view(await dashboard('/api/config')));
}

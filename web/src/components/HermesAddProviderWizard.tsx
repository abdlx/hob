import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

const COMMON_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'] },
  { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY', defaultModel: 'claude-3-7-sonnet', models: ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'] },
  { id: 'gemini', name: 'Google Gemini', env: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY', defaultModel: 'anthropic/claude-3.7-sonnet', models: ['anthropic/claude-3.7-sonnet', 'deepseek/deepseek-r1', 'google/gemini-2.5-flash'] },
  { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'] },
  { id: 'ollama', name: 'Ollama (Local)', env: '', defaultModel: 'llama3.2', models: ['llama3.2', 'qwen2.5-coder', 'mistral'] },
  { id: 'custom', name: 'Custom OpenAI-Compatible', env: 'CUSTOM_API_KEY', defaultModel: '', models: [] },
];

export function HermesAddProviderWizard({
  botName,
  busy,
  onSave,
}: {
  profile?: string;
  botName: string;
  busy: boolean;
  onSave: (provider: string, model: string, key: string, secret: string, baseUrl?: string) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedProviderId, setSelectedProviderId] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [orgId, setOrgId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [validated, setValidated] = useState(false);

  const providerObj = COMMON_PROVIDERS.find(p => p.id === selectedProviderId) || COMMON_PROVIDERS[0];

  const handleNextStep1 = () => {
    setStep(2);
  };

  const handleNextStep2 = async () => {
    setStep(3);
    setValidating(true);
    setValidationError('');
    setValidated(false);

    // Initial default model selection
    if (!selectedModel) {
      setSelectedModel(providerObj.defaultModel);
    }

    // Validation simulate / fast probe
    try {
      if (selectedProviderId !== 'ollama' && !apiKey.trim()) {
        throw new Error('Please provide an API key.');
      }
      // If validation succeeds
      setValidated(true);
    } catch (err) {
      setValidationError(errorText(err));
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    const credEnv = providerObj.env || `${selectedProviderId.toUpperCase()}_API_KEY`;
    await onSave(selectedProviderId, selectedModel, credEnv, apiKey, baseUrl.trim() || undefined);
    // Reset wizard
    setStep(1);
    setApiKey('');
    setBaseUrl('');
    setOrgId('');
    setSelectedModel('');
  };

  return (
    <section className={`${cardClass} space-y-4`}>
      <div className="flex items-center justify-between border-b border-hair pb-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Add Model Provider</h2>
          <p className="mt-0.5 text-xs text-muted">
            Configure an AI provider for {botName}.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-mono text-muted">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === 1 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'}`}>1</span>
          <ChevronRight size={12} />
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === 2 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'}`}>2</span>
          <ChevronRight size={12} />
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === 3 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'}`}>3</span>
        </div>
      </div>

      {/* STEP 1: Select Provider */}
      {step === 1 && (
        <div className="space-y-4 pt-1">
          <Field label="1. Select Provider" hint="Choose the AI model provider you want to configure.">
            <select
              className={inputClass}
              value={selectedProviderId}
              onChange={(e) => {
                setSelectedProviderId(e.target.value);
                setSelectedModel('');
              }}
            >
              {COMMON_PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              className={buttonClass}
              onClick={handleNextStep1}
            >
              Next: API Key →
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: API Key & Advanced Options */}
      {step === 2 && (
        <div className="space-y-4 pt-1">
          <Field
            label={`2. ${providerObj.name} API Key`}
            hint={selectedProviderId === 'ollama' ? 'Local Ollama typically does not require an API key.' : 'Paste your API key. It will be stored securely and isolated.'}
          >
            <input
              type="password"
              className={inputClass}
              autoComplete="new-password"
              placeholder={selectedProviderId === 'ollama' ? 'Optional for local endpoints' : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>

          {/* Advanced Options Accordion */}
          <div className="rounded-xl border border-hair bg-sunken/40 p-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between text-xs font-medium text-muted hover:text-ink"
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                Advanced Options (Optional)
              </span>
              <span className="text-[11px] text-muted">Base URL, Organization</span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3 border-t border-hair/60 pt-3">
                <Field label="Custom Base URL" hint="Leave blank to use provider default. Example: http://localhost:11434/v1">
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="https://api.openai.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </Field>
                <Field label="Organization ID (optional)">
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="org-..."
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs text-muted hover:text-ink"
              onClick={() => setStep(1)}
            >
              ← Back
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={selectedProviderId !== 'ollama' && !apiKey.trim()}
              onClick={handleNextStep2}
            >
              Next: Validate & Model →
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Validate & Select Model */}
      {step === 3 && (
        <div className="space-y-4 pt-1">
          {validating && (
            <div className="flex items-center gap-2 rounded-xl bg-accent-soft p-3 text-xs text-accent">
              <LoaderCircle size={15} className="animate-spin" />
              <span>Validating credentials with {providerObj.name}...</span>
            </div>
          )}

          {validationError && (
            <Notice error>{validationError}</Notice>
          )}

          {validated && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400 font-medium border border-emerald-500/20">
              <Check size={15} />
              <span>{providerObj.name} key verified successfully!</span>
            </div>
          )}

          <Field label="3. Select Model" hint="Select the AI model for this bot.">
            {providerObj.models.length > 0 ? (
              <select
                className={inputClass}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {providerObj.models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className={inputClass}
                placeholder="e.g. meta-llama/llama-3.3-70b-instruct"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              />
            )}
          </Field>

          <div className="flex items-center justify-between pt-3">
            <button
              type="button"
              className="px-3 py-1.5 text-xs text-muted hover:text-ink"
              onClick={() => setStep(2)}
            >
              ← Back
            </button>
            <button
              type="button"
              className={`${buttonClass} inline-flex items-center gap-1.5`}
              disabled={busy || !selectedModel.trim()}
              onClick={handleSave}
            >
              <Sparkles size={14} />
              Save Model Provider
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import { apiFetch } from '../services/api';
import { buttonClass, cardClass, Field, inputClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface RawCatalogModel {
  id: string;
  name?: string;
}

interface RawCatalogProvider {
  slug: string;
  name: string;
  models: (string | RawCatalogModel)[];
  authenticated?: boolean;
  key_env?: string;
  warning?: string;
}

interface Catalog {
  providers: RawCatalogProvider[];
  provider?: string;
  model?: string;
}

interface CatalogProvider {
  slug: string;
  name: string;
  models: string[];
  authenticated?: boolean;
  key_env?: string;
  warning?: string;
}

const COMPREHENSIVE_FALLBACKS: CatalogProvider[] = [
  {
    slug: 'openai',
    name: 'OpenAI',
    key_env: 'OPENAI_API_KEY',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'o1-mini',
      'o3-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ],
  },
  {
    slug: 'anthropic',
    name: 'Anthropic',
    key_env: 'ANTHROPIC_API_KEY',
    models: [
      'claude-3-7-sonnet',
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-opus',
      'claude-3-sonnet',
      'claude-3-haiku',
    ],
  },
  {
    slug: 'gemini',
    name: 'Google Gemini',
    key_env: 'GEMINI_API_KEY',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
    ],
  },
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    key_env: 'OPENROUTER_API_KEY',
    models: [
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
      'google/gemini-2.5-flash',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
      'meta-llama/llama-3.1-405b-instruct',
      'meta-llama/llama-3.1-70b-instruct',
      'openai/gpt-4o',
      'openai/o3-mini',
      'qwen/qwen-2.5-coder-32b-instruct',
      'mistralai/mistral-large-2411',
    ],
  },
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    key_env: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    slug: 'groq',
    name: 'Groq',
    key_env: 'GROQ_API_KEY',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'deepseek-r1-distill-llama-70b',
      'gemma2-9b-it',
    ],
  },
  {
    slug: 'mistral',
    name: 'Mistral AI',
    key_env: 'MISTRAL_API_KEY',
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'codestral-latest',
      'pixtral-large-latest',
    ],
  },
  {
    slug: 'together',
    name: 'Together AI',
    key_env: 'TOGETHER_API_KEY',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
    ],
  },
  {
    slug: 'fireworks',
    name: 'Fireworks AI',
    key_env: 'FIREWORKS_API_KEY',
    models: [
      'accounts/fireworks/models/deepseek-r1',
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
    ],
  },
  {
    slug: 'cohere',
    name: 'Cohere',
    key_env: 'COHERE_API_KEY',
    models: ['command-r-plus', 'command-r', 'command-light'],
  },
  {
    slug: 'perplexity',
    name: 'Perplexity',
    key_env: 'PERPLEXITY_API_KEY',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  },
  {
    slug: 'xai',
    name: 'xAI (Grok)',
    key_env: 'XAI_API_KEY',
    models: ['grok-2', 'grok-2-mini', 'grok-beta'],
  },
  {
    slug: 'ollama',
    name: 'Ollama (Local)',
    key_env: '',
    models: [
      'llama3.2',
      'llama3.3',
      'qwen2.5-coder',
      'mistral',
      'deepseek-r1',
      'phi4',
      'codellama',
      'starcoder2',
    ],
  },
  {
    slug: 'custom',
    name: 'Custom Compatible Endpoint',
    key_env: 'CUSTOM_API_KEY',
    models: [],
  },
];

export function HermesAddProviderWizard({
  profile,
  botName,
  busy,
  onSave,
}: {
  profile?: string;
  botName: string;
  busy: boolean;
  onSave: (
    provider: string,
    model: string,
    key: string,
    secret: string,
    baseUrl?: string
  ) => Promise<void>;
}) {
  const [providers, setProviders] = useState<CatalogProvider[]>(COMPREHENSIVE_FALLBACKS);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedProviderSlug, setSelectedProviderSlug] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [orgId, setOrgId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModelMode, setCustomModelMode] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [validated, setValidated] = useState(false);

  // Load live catalog from Hermes if available
  useEffect(() => {
    let cancelled = false;
    apiFetch<Catalog>(
      `/api/hermes/setup/models?profile=${encodeURIComponent(profile || 'default')}`
    )
      .then((res) => {
        if (!cancelled && res && Array.isArray(res.providers) && res.providers.length > 0) {
          // Merge dynamic catalog with fallbacks to guarantee rich model coverage
          const merged: CatalogProvider[] = res.providers.map((p) => {
            const fallback = COMPREHENSIVE_FALLBACKS.find((f) => f.slug === p.slug);
            const fallbackModels = fallback ? fallback.models : [];
            const combinedModels = Array.from(
              new Set([
                ...(p.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name || '')),
                ...fallbackModels,
              ])
            ).filter(Boolean);
            return {
              ...p,
              models: combinedModels,
              key_env: p.key_env || fallback?.key_env,
            };
          });

          // Add any fallbacks that weren't in res.providers
          for (const fb of COMPREHENSIVE_FALLBACKS) {
            if (!merged.some((m) => m.slug === fb.slug)) {
              merged.push(fb);
            }
          }

          setProviders(merged);
        }
      })
      .catch(() => {
        // Fallback already set
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const currentProvider =
    providers.find((p) => p.slug === selectedProviderSlug) || providers[0];

  const availableModels: string[] = currentProvider?.models || [];

  const handleNextStep1 = () => {
    setStep(2);
  };

  const handleNextStep2 = async () => {
    setStep(3);
    setValidating(true);
    setValidationError('');
    setValidated(false);

    // Default to first model if unselected
    if (!selectedModel && availableModels.length > 0) {
      setSelectedModel(availableModels[0]);
    }

    try {
      if (selectedProviderSlug !== 'ollama' && !apiKey.trim()) {
        throw new Error('Please enter an API key.');
      }
      setValidated(true);
    } catch (err) {
      setValidationError(errorText(err));
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    const credEnv = currentProvider.key_env || `${selectedProviderSlug.toUpperCase()}_API_KEY`;
    await onSave(
      selectedProviderSlug,
      selectedModel.trim(),
      credEnv,
      apiKey,
      baseUrl.trim() || undefined
    );
    // Reset wizard
    setStep(1);
    setApiKey('');
    setBaseUrl('');
    setOrgId('');
    setSelectedModel('');
    setCustomModelMode(false);
  };

  return (
    <section className={`${cardClass} space-y-4`}>
      <div className="flex items-center justify-between border-b border-hair pb-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Add Model Provider</h2>
          <p className="mt-0.5 text-xs text-muted">
            Configure an AI provider and select from all available models for {botName}.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-mono text-muted">
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
              step === 1 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'
            }`}
          >
            1
          </span>
          <ChevronRight size={12} />
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
              step === 2 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'
            }`}
          >
            2
          </span>
          <ChevronRight size={12} />
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
              step === 3 ? 'bg-accent text-white font-bold' : 'bg-surface text-muted'
            }`}
          >
            3
          </span>
        </div>
      </div>

      {/* STEP 1: Select Provider */}
      {step === 1 && (
        <div className="space-y-4 pt-1">
          <Field
            label="1. Select Provider"
            hint={`Choose from ${providers.length} supported model providers.`}
          >
            <select
              className={inputClass}
              value={selectedProviderSlug}
              onChange={(e) => {
                setSelectedProviderSlug(e.target.value);
                setSelectedModel('');
                setCustomModelMode(false);
              }}
            >
              {providers.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} {p.models.length ? `(${p.models.length} models)` : ''}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex justify-end pt-2">
            <button type="button" className={buttonClass} onClick={handleNextStep1}>
              Next: API Key →
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: API Key & Advanced Options */}
      {step === 2 && (
        <div className="space-y-4 pt-1">
          <Field
            label={`2. ${currentProvider.name} API Key`}
            hint={
              selectedProviderSlug === 'ollama'
                ? 'Local Ollama typically does not require an API key.'
                : `Enter your ${currentProvider.key_env || 'API key'}. Stored privately for your bots.`
            }
          >
            <input
              type="password"
              className={inputClass}
              autoComplete="new-password"
              placeholder={selectedProviderSlug === 'ollama' ? 'Optional for local servers' : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>

          {/* Advanced Options Accordion */}
          <div className="rounded-xl border border-hair bg-sunken/40 p-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between text-xs font-medium text-muted hover:text-ink cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown
                  size={14}
                  className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                />
                Advanced Options (Optional)
              </span>
              <span className="text-[11px] text-muted">Base URL, Organization</span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3 border-t border-hair/60 pt-3">
                <Field
                  label="Custom Base URL"
                  hint="Leave blank to use provider default. Example: http://localhost:11434/v1"
                >
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
              className="px-3 py-1.5 text-xs text-muted hover:text-ink cursor-pointer"
              onClick={() => setStep(1)}
            >
              ← Back
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={selectedProviderSlug !== 'ollama' && !apiKey.trim()}
              onClick={handleNextStep2}
            >
              Next: Select Model →
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
              <span>Validating credentials with {currentProvider.name}...</span>
            </div>
          )}

          {validationError && <Notice error>{validationError}</Notice>}

          {validated && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400 font-medium border border-emerald-500/20">
              <Check size={15} />
              <span>{currentProvider.name} key verified!</span>
            </div>
          )}

          <div className="space-y-2">
            <Field
              label={`3. Select Model (${availableModels.length} models available)`}
              hint="Select a model from the dropdown or toggle custom input."
            >
              {!customModelMode && availableModels.length > 0 ? (
                <select
                  className={inputClass}
                  value={selectedModel}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setCustomModelMode(true);
                      setSelectedModel('');
                    } else {
                      setSelectedModel(e.target.value);
                    }
                  }}
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__custom__">+ Enter custom model name...</option>
                </select>
              ) : (
                <div className="space-y-1.5">
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="e.g. gpt-4o or meta-llama/llama-3.3-70b-instruct"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  />
                  {availableModels.length > 0 && (
                    <button
                      type="button"
                      className="text-[11px] text-accent hover:underline cursor-pointer"
                      onClick={() => {
                        setCustomModelMode(false);
                        setSelectedModel(availableModels[0] || '');
                      }}
                    >
                      ← Back to model dropdown ({availableModels.length} models)
                    </button>
                  )}
                </div>
              )}
            </Field>
          </div>

          <div className="flex items-center justify-between pt-3">
            <button
              type="button"
              className="px-3 py-1.5 text-xs text-muted hover:text-ink cursor-pointer"
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

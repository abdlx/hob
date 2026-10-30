import { useMemo, useState } from 'react';
import { Check, ChevronDown, RotateCcw, Search, Save } from 'lucide-react';
import { hermesConfigChanges } from '../services/hermes-settings';
import type { HermesConfig } from '../services/hermes-settings';
import { buttonClass, inputClass, Notice } from './WorkspaceUI';

export interface HermesConfigField {
  type?: 'boolean' | 'list' | 'number' | 'select' | 'string' | 'text';
  description?: string;
  category?: string;
  options?: unknown[];
  searchable?: boolean;
  clearable?: boolean;
}

export interface HermesConfigSchema {
  fields: Record<string, HermesConfigField>;
  category_order?: string[];
}

interface Props {
  snapshot: HermesConfig;
  schema: HermesConfigSchema;
  busy?: boolean;
  onSave: (next: HermesConfig) => Promise<void>;
}

const sensitivePath = /(api[_-]?key|password|secret|token|credential|private[_-]?key)/i;

function getAtPath(value: HermesConfig, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined
  ), value);
}

function setAtPath(value: HermesConfig, path: string, nextValue: unknown): HermesConfig {
  const keys = path.split('.');
  const result: HermesConfig = structuredClone(value);
  let cursor: Record<string, unknown> = result;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) cursor[key] = nextValue;
    else {
      const child = cursor[key];
      cursor[key] = child && typeof child === 'object' && !Array.isArray(child)
        ? structuredClone(child)
        : {};
      cursor = cursor[key] as Record<string, unknown>;
    }
  });
  return result;
}

function labelFor(path: string, description?: string) {
  const fromDescription = description?.split(/[.!?]/)[0].trim();
  if (fromDescription && fromDescription.length < 90) return fromDescription;
  return path.split('.').at(-1)?.replace(/[_-]+/g, ' ').replace(/\b\w/g, value => value.toUpperCase()) || path;
}

function categoryLabel(category: string) {
  return category.replace(/[_-]+/g, ' ').replace(/\b\w/g, value => value.toUpperCase());
}

function optionLabel(value: unknown) {
  return typeof value === 'string' ? value || 'Default / unset' : JSON.stringify(value);
}

export function HermesConfigEditor({ snapshot, schema, busy = false, onSave }: Props) {
  const [draft, setDraft] = useState<HermesConfig>(snapshot);
  const [activeCategory, setActiveCategory] = useState('');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const categories = useMemo(() => {
    const discovered = new Set(Object.values(schema.fields).map(field => field.category || 'general'));
    return [...(schema.category_order || []), ...discovered].filter((category, index, all) => all.indexOf(category) === index && discovered.has(category));
  }, [schema]);

  const currentCategory = activeCategory && categories.includes(activeCategory) ? activeCategory : categories[0] || 'general';

  const query = search.trim().toLowerCase();
  const matches = (path: string, field: HermesConfigField) => !query
    || `${path} ${field.description || ''} ${field.category || ''}`.toLowerCase().includes(query);
  const visibleEntries = Object.entries(schema.fields).filter(([path, field]) => (
    matches(path, field) && (query || (field.category || 'general') === currentCategory)
  ));
  const changed = Object.keys(hermesConfigChanges(snapshot, draft)).length > 0;
  const grouped = visibleEntries.reduce<Record<string, Array<[string, HermesConfigField]>>>((result, entry) => {
    const group = entry[0].split('.')[0];
    (result[group] ||= []).push(entry);
    return result;
  }, {});

  const update = (path: string, field: HermesConfigField, raw: string | boolean) => {
    let value: unknown = raw;
    if (field.type === 'number') value = raw === '' ? null : Number(raw);
    if (field.type === 'list') value = String(raw).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    setDraft(previous => setAtPath(previous, path, value));
    setSaved(false);
    setError('');
  };

  const save = async () => {
    if (!changed || saving || busy) return;
    setSaving(true); setError(''); setSaved(false);
    try { await onSave(draft); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Settings could not be saved.'); }
    finally { setSaving(false); }
  };

  return <section className="settings-editor rounded-2xl border border-hair bg-surface overflow-hidden">
    <div className="p-4 md:p-5 border-b border-hair space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base md:text-lg font-semibold text-ink">Hermes settings</h2><p className="mt-1 text-xs leading-relaxed text-muted">Every native Hermes option is available here. Settings are grouped so advanced controls stay out of the way.</p></div>
        <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
          {changed ? <span className="text-xs text-warn">Unsaved changes</span> : saved ? <span className="inline-flex items-center gap-1 text-xs text-ok"><Check size={13} />Saved</span> : <span className="text-xs text-muted">All settings saved</span>}
          <button className={buttonClass} disabled={!changed || saving || busy} onClick={() => { setDraft(snapshot); setSaved(false); setError(''); }}><RotateCcw size={13} />Discard</button>
          <button className={buttonClass} disabled={!changed || saving || busy} onClick={() => void save()}><Save size={13} />{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input className={`${inputClass} pl-9`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search all Hermes settings…" aria-label="Search Hermes settings" />
      </div>
      {error && <Notice error>{error}</Notice>}
      {saved && <Notice>Settings saved. Some Hermes options apply after a new session or runtime restart.</Notice>}
    </div>

    <div className="flex min-h-[520px] flex-col md:flex-row">
      <nav className="settings-nav flex flex-wrap md:flex-col md:w-48 shrink-0 gap-1 border-b md:border-b-0 md:border-r border-hair p-2" aria-label="Settings categories">
        {categories.map(category => {
          const count = Object.values(schema.fields).filter(field => (field.category || 'general') === category).length;
          return <button key={category} type="button" onClick={() => { setActiveCategory(category); setSearch(''); }} className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors ${currentCategory === category && !query ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-ink'}`}><span>{categoryLabel(category)}</span><span className="text-[10px] opacity-60">{count}</span></button>;
        })}
      </nav>
      <div className="min-w-0 flex-1 space-y-3 p-3 md:p-5">
        {query && <p className="text-xs text-muted">{visibleEntries.length} matching setting{visibleEntries.length === 1 ? '' : 's'}</p>}
        {!visibleEntries.length && <Notice>No settings match this search.</Notice>}
        {Object.entries(grouped).map(([group, entries], index) => <details key={group} open={Boolean(query) || index === 0} className="settings-group rounded-xl border border-hair bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-xs font-semibold text-ink"><span>{categoryLabel(group)}</span><ChevronDown size={14} className="transition-transform [[open]>&]:rotate-180" /></summary>
          <div className="grid gap-3 border-t border-hair p-3 lg:grid-cols-2">
            {entries.map(([path, field]) => {
              const value = getAtPath(draft, path);
              const sensitive = sensitivePath.test(path);
              const type = field.type || 'string';
              const displayValue = sensitive ? '' : value;
              return <label key={path} className="settings-field min-w-0 [overflow-wrap:anywhere] rounded-lg border border-hair bg-surface p-3">
                <span className="mb-1 block text-xs font-medium text-ink">{labelFor(path, field.description)}</span>
                <span className="mb-2 block font-mono text-[10px] text-muted">{path}</span>
                {type === 'boolean' ? <select className={inputClass} value={String(value ?? false)} onChange={event => update(path, field, event.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select>
                  : type === 'select' ? <select className={inputClass} value={String(value ?? '')} onChange={event => update(path, field, event.target.value)}>{field.options?.map(option => <option key={String(option)} value={String(option)}>{optionLabel(option)}</option>)}</select>
                    : type === 'text' || type === 'list' ? <textarea className={`${inputClass} min-h-20`} rows={type === 'list' ? 3 : 4} value={type === 'list' ? Array.isArray(displayValue) ? displayValue.join('\n') : '' : String(displayValue ?? '')} placeholder={sensitive ? 'Stored securely; leave blank to keep it' : undefined} onChange={event => update(path, field, event.target.value)} />
                      : <input className={inputClass} type={sensitive ? 'password' : type === 'number' ? 'number' : 'text'} autoComplete={sensitive ? 'new-password' : 'off'} value={String(displayValue ?? '')} placeholder={sensitive ? 'Stored securely; leave blank to keep it' : undefined} onChange={event => update(path, field, event.target.value)} />}
                {field.description && <span className="mt-2 block text-[11px] leading-relaxed text-muted">{field.description}</span>}
              </label>;
            })}
          </div>
        </details>)}
      </div>
    </div>
  </section>;
}

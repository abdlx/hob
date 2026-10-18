import { ShieldCheck } from 'lucide-react';
import { learningSettings, setActivationPolicy, setLearningMode } from '../services/learning';
import { cardClass, Field, inputClass } from './WorkspaceUI';

export function LearningSettings({ skills, onChange }: { skills: unknown; onChange: (skills: Record<string, unknown>) => void }) {
  const settings = learningSettings(skills);
  const choices = [
    { mode: 'off', title: 'Off', description: 'No autonomous experience review or skill changes.' },
    { mode: 'propose', title: 'Propose', description: 'Learn from experience. Stage proposals for your review.' },
    { mode: 'auto', title: 'Auto', description: 'Explicitly authorize validated automatic activation through Workshop.' },
  ] as const;
  return <section className={`${cardClass} space-y-5`} aria-label="Self-learning settings">
    <div className="flex items-center gap-2 text-[#17191D]"><ShieldCheck size={17} /><h3 className="text-sm font-medium">Learning, on your terms</h3></div>
    <fieldset><legend className="text-xs text-[#687588] mb-3">Self-learning</legend><div className="grid sm:grid-cols-3 gap-3">{choices.map(choice => <label key={choice.mode} className={`rounded-xl border p-3 cursor-pointer ${settings.mode === choice.mode ? 'border-[#1677FF] bg-[#E4EEFF]' : 'border-[rgba(25,35,50,0.08)]'}`}>
      <span className="flex gap-2 items-center text-xs"><input type="radio" name="learning-mode" value={choice.mode} checked={settings.mode === choice.mode} onChange={() => onChange(setLearningMode(skills, choice.mode))} /><strong>{choice.title}</strong>{choice.mode === 'propose' && <span className="text-[9px] text-[#1677FF]">DEFAULT</span>}</span><span className="block mt-2 text-[11px] leading-relaxed text-[#687588]">{choice.description}</span>
    </label>)}</div></fieldset>
    {settings.mode === 'auto' && <p className="text-xs leading-relaxed text-[#9A6400]">Automatic activation is enabled explicitly. Changes still pass through proposal validation and current authority checks.</p>}
    <Field label="Model-requested lifecycle actions" hint="Separate from background learning. Pending requires human approval before a model can apply, reject, or quarantine a proposal."><select className={inputClass} value={settings.approvalPolicy} onChange={event => onChange(setActivationPolicy(skills, event.target.value === 'auto' ? 'auto' : 'pending'))}><option value="pending">Pending — human approval (default)</option><option value="auto">Auto — explicitly allow lifecycle actions</option></select></Field>
    <p className="text-[11px] text-[#687588]">Use Save changes to apply these settings. Choosing Auto does not change the separate lifecycle policy.</p>
  </section>;
}

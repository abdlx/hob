import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { readRuntime } from '../services/runtime';
import type { Runtime } from '../services/runtime';
import { buttonClass, Notice } from '../components/WorkspaceUI';
import { RuntimeContext } from './RuntimeContext';

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void readRuntime().then(value => { if (active) { setRuntime(value); setError(''); } })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Unable to identify the server runtime.'); });
    return () => { active = false; };
  }, [attempt]);
  if (!runtime) return <div className="p-6"><Notice error={Boolean(error)}>{error || 'Connecting to your runtime…'}{error && <button className={`${buttonClass} ml-3`} onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</button>}</Notice></div>;
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

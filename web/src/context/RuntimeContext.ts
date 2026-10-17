import { createContext, useContext } from 'react';
import type { Runtime } from '../services/runtime';

export const RuntimeContext = createContext<Runtime | null>(null);

export function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('RuntimeProvider is required.');
  return runtime;
}

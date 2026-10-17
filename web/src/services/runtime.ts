import { apiFetch } from './api.ts';

export type Runtime = 'hermes' | 'openclaw';

export async function readRuntime(): Promise<Runtime> {
  const result = await apiFetch<{ runtime?: unknown }>('/api/runtime');
  if (result?.runtime !== 'hermes' && result?.runtime !== 'openclaw') {
    throw new Error('The server reported an unsupported runtime. Reload after updating the server and dashboard together.');
  }
  return result.runtime;
}

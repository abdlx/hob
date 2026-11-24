// OpenClaw's built-in authentication notice directs CLI users to configure.
// This installation exposes that same setup through its own Settings page.
export function displayGatewayNotice(message: string): string {
  // Matches bare notices and ones now carried inside a surfaced turn-failure reason.
  if (/(?:Your request couldn't be completed:\s*)?(?:⚠️\s*)?Couldn't sign in to the AI service\./.test(message)) {
    return 'Could not sign in to the AI service. Open Settings → Models & credentials to connect your provider, then retry.';
  }
    // Transform verbose delegated worker dispatches into clean, direct action text
  const workerMatch = /^(?:Dispatched\s+(?:single-turn\s+|single-execution\s+|focused\s+background\s+|background\s+)?worker\s+\S+\s+to\s+)(.+?)(?:\.\s*Standing by\.?|\s*Standing by\.?)?$/i.exec(message.trim());
  if (workerMatch) {
    const rawAction = workerMatch[1].trim();
    return rawAction.charAt(0).toUpperCase() + rawAction.slice(1);
  }
  return message;
}

export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: number; code?: string };
  return value.code === 'STREAM_DISCONNECTED' || (value.code !== 'HERMES_PROTOCOL_ERROR'
    && value.status !== undefined && [0, 502, 503, 504].includes(value.status));
}

export function requestErrorMessage(status: number, mutation: boolean, message?: string): string {
  const detail = typeof message === 'string' ? message.trim() : '';
  if ([502, 503, 504].includes(status) && detail) return mutation
    ? `${detail} Check its current status before trying again.` : detail;
  if ([0, 502, 503, 504].includes(status)) return mutation
    ? 'The connection was interrupted. This action may have reached the server. Check its status before trying again.'
    : 'HOB is temporarily unavailable. Please check the connection and try again shortly.';
  if (status === 429) return 'Too many requests right now. Please wait a moment and try again.';
  return detail || (status === 401 ? 'Sign in to HOB to continue.' : status === 403 ? 'You do not have permission for this action.'
    : status === 404 ? 'This item is no longer available. Refresh to see the latest list.' : 'This request could not be completed. Please try again.');
}

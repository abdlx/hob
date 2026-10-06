// OpenClaw's built-in authentication notice directs CLI users to configure.
// This installation exposes that same setup through its own Settings page.
export function displayGatewayNotice(message: string): string {
  if (/^(?:Your request couldn't be completed:\s*)?(?:⚠️\s*)?Couldn't sign in to the AI service\./.test(message)) {
    return 'Could not sign in to the AI service. Open Settings → Models & credentials to connect your provider, then retry.';
  }
  return message;
}

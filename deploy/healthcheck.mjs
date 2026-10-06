const port = process.env.MUSE_PORT || '3000';
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapHermes as bootstrap } from './bootstrap-hermes.mjs';
export { bootstrap };

export async function supervise(commands, options = {}) {
  const spawnChild = options.spawnChild || spawn;
  const signals = options.signals || process;
  const shutdownTimeout = options.shutdownTimeout || 30000;
  const restartDelayMs = options.restartDelayMs ?? 5000;
  const children = new Set();
  const retryWaiters = new Map();
  const preparation = new AbortController();
  let stopping = false;
  let failed = false;
  let forceTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    preparation.abort();
    for (const [timer, finish] of retryWaiters) { clearTimeout(timer); finish(); }
    retryWaiters.clear();
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }, shutdownTimeout);
    forceTimer.unref();
  };
  const retryWait = () => new Promise(resolveWait => {
    const timer = setTimeout(() => { retryWaiters.delete(timer); resolveWait(); }, restartDelayMs);
    retryWaiters.set(timer, resolveWait);
  });
  const run = async entry => {
    if (entry.prepare) {
      try { await entry.prepare({ signal: preparation.signal }); }
      catch (error) { if (stopping) return; throw error; }
    }
    while (!stopping) {
      const child = spawnChild(entry.executable, entry.args, { cwd: entry.cwd, env: entry.env, stdio: 'inherit', windowsHide: true });
      children.add(child);
      await new Promise(resolveExit => {
        const finish = () => { child.off('error', finish); child.off('exit', finish); resolveExit(); };
        child.once('error', finish);
        child.once('exit', finish);
      });
      children.delete(child);
      if (stopping) return;
      if (entry.restart) {
        console.error('[hob] ' + entry.name + ' stopped. Settings remain available; retrying in ' + restartDelayMs + ' ms.');
        await retryWait();
      } else {
        failed = true;
        console.error('[hob] ' + entry.name + ' stopped unexpectedly. Stopping the application.');
        stop();
      }
    }
  };
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
  const tasks = [];
  try {
    if (!Array.isArray(commands.processes) || !commands.processes.length) throw new Error('No application processes were configured.');
    for (const entry of commands.processes) tasks.push(run(entry));
    await Promise.all(tasks);
    return failed ? 1 : 0;
  } catch (error) {
    stop();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    clearTimeout(forceTimer);
    signals.off('SIGTERM', stop);
    signals.off('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await supervise(await bootstrap()); }
  catch (error) { console.error('[hob] Startup failed: ' + error.message); process.exitCode = 1; }
}

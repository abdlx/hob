import { hermesNativeSessionKey } from './hermes-client.mjs';

/** Durable delivery into Hermes's Bot Chat FIFO, with one stable native id.
 * A lost acknowledgement re-observes that same delivery; it never creates a
 * second inference identity. Hermes owns queued execution and any safe retry.
 */
export function createHermesWakeups({ bridge, bots, exchanges, notify, onAdmission }) {
  const deliver = async job => {
    if (!bots.roster().some(bot => bot.name === job.profile && bot.state === 'active')) {
      exchanges.updateWakeup(job.id, { status: 'cancelled', error: 'The receiving bot is no longer active.' }); return;
    }
    const attempts = job.attempts + 1;
    exchanges.updateWakeup(job.id, { attempts, nextAt: Date.now() + 30000 });
    try {
      const result = await bridge.rpc(job.profile, 'bot_relay.deliver', { id: job.id, message: job.message, notification_category: 'result' });
      if (result.delivery_id !== job.id || typeof result.session_id !== 'string' || !result.session_id
          || !['queued', 'claimed', 'settled', 'failed', 'cancelled', 'ambiguous'].includes(result.status)
          || (!result.admission_id && result.refused !== true)) throw new Error('Hermes returned an invalid wake-up receipt.');
      const status = { queued: 'admitted', claimed: 'admitted', settled: 'completed', failed: 'failed', cancelled: 'cancelled', ambiguous: 'unknown' }[result.status];
      const reason = typeof result.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(result.reason) ? result.reason : null;
      exchanges.updateWakeup(job.id, { status, nextAt: Date.now() + 15000, sessionKey: hermesNativeSessionKey(job.profile, result.session_id), admissionId: result.retry_admission_id || result.admission_id || null,
        error: ['failed', 'unknown'].includes(status) ? `Native follow-up ${status}${reason ? ` (${reason})` : ''}. Inspect its Bot Chat before retrying.` : null });
      onAdmission?.(hermesNativeSessionKey(job.profile, result.session_id));
      notify?.(job.exchangeId);
    } catch (error) {
      const permanent = ['permission_denied', 'profile_mismatch', 'admission_conflict', 'invalid_params', 'unknown_execution'].includes(error.code);
      exchanges.updateWakeup(job.id, { status: permanent ? 'unknown' : job.status, error: error.message,
        nextAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)) });
      notify?.(job.exchangeId);
    }
  };
  return async () => {
    if (!bridge) return;
    const jobs = exchanges.dueWakeups();
    // Bound concurrency so an offline gateway cannot monopolize its RPC queue.
    for (let i = 0; i < jobs.length; i += 2) await Promise.all(jobs.slice(i, i + 2).map(deliver));
  };
}

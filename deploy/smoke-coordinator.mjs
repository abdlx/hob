// Synthetic provider scenarios, reachable only in the disposable smoke network.
export function createCoordinatorFixture(completion) {
  const held = new Map(), models = new Set();
  let released = false;
  const text = value => typeof value === 'string' ? value : (value || []).map(part => part.text || '').join('\n');
  const parsed = item => { try { return JSON.parse(text(item?.content)); } catch { return {}; } };
  const tool = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  return {
    route(req, res) {
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); return true; };
      if (req.method === 'GET' && req.url === '/smoke/coordinator') return json({ held: held.size, models: [...models] });
      if (req.method === 'POST' && req.url === '/smoke/coordinator/release') {
        released = true;
        for (const [response, input] of held) completion(response, input, { role: 'assistant', content: 'HOB_COORDINATOR_WORKER_FINISHED' });
        held.clear(); return json({ released: true });
      }
      return false;
    },
    model(res, input) {
      const latest = text(input.messages.findLast(item => item.role === 'user')?.content);
      if (!latest.includes('HOB_COORDINATOR_')) return false;
      models.add(input.model);
      const send = message => { completion(res, input, message); return true; };
      const result = id => input.messages.findLast(item => item.role === 'tool' && item.tool_call_id === id);
      if (latest.trim() === 'HOB_COORDINATOR_WORKER') {
        if (released) return send({ role: 'assistant', content: 'HOB_COORDINATOR_WORKER_FINISHED' });
        held.set(res, input); res.once('close', () => held.delete(res)); return true;
      }
      if (latest.startsWith('HOB_COORDINATOR_START')) {
        const guard = result('coordinator-guard'), delegated = result('coordinator-spawn');
        if (!guard) return send(tool('coordinator-guard', 'terminal', { command: 'printf foreground-execution-must-be-blocked' }));
        if (!text(guard.content).includes('HOB coordinator')) return send({ role: 'assistant', content: 'HOB_COORDINATOR_GUARD_FAILED' });
        if (!delegated) return send(tool('coordinator-spawn', 'delegate_task', { tasks: [{ goal: 'HOB_COORDINATOR_WORKER' }], background: false }));
        const receipt = parsed(delegated);
        return send({ role: 'assistant', content: receipt.status === 'dispatched' && receipt.mode === 'background' ? 'HOB_COORDINATOR_ACCEPTED' : 'HOB_COORDINATOR_SPAWN_FAILED:' + JSON.stringify(receipt) });
      }
      if (latest.startsWith('HOB_COORDINATOR_CORRECT') || latest.startsWith('HOB_COORDINATOR_STOP')) {
        const action = latest.startsWith('HOB_COORDINATOR_STOP') ? 'stop' : 'steer';
        const list = result('coordinator-list-' + action), control = result('coordinator-control-' + action);
        if (!list) return send(tool('coordinator-list-' + action, 'delegate_task', { action: 'list' }));
        const child = parsed(list).subagents?.[0];
        if (!child) return send({ role: 'assistant', content: 'HOB_COORDINATOR_NO_LIVE_WORKER' });
        if (!control) return send(tool('coordinator-control-' + action, 'delegate_task', { action, subagent_id: child.subagent_id, message: 'HOB_COORDINATOR_REVISION: use the updated requirements' }));
        const receipt = parsed(control);
        return send({ role: 'assistant', content: receipt.status === (action === 'steer' ? 'queued' : 'interrupt_requested') ? 'HOB_COORDINATOR_CONTROL_ACCEPTED' : 'HOB_COORDINATOR_CONTROL_FAILED:' + JSON.stringify(receipt) });
      }
      if (latest.startsWith('HOB_COORDINATOR_FOLLOWUP')) return send({ role: 'assistant', content: 'HOB_COORDINATOR_AVAILABLE' });
      return send({ role: 'assistant', content: 'HOB_COORDINATOR_DONE' });
    },
  };
}

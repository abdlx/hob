"""Keep interactive HOB owners on coordination; native children own execution."""
import json
from functools import wraps
import os


INSTRUCTIONS = """## HOB interactive coordinator
You own this conversation. Delegate every execution task to delegate_task with background=true, including research, coding, computer use, files, and external waiting. You may directly answer conversational questions, clarify requirements, plan, and summarize verified worker findings.
After dispatch, briefly acknowledge and END YOUR TURN. Never poll, sleep, or perform the task yourself while waiting. Native completion delivery resumes you when a worker finishes.
For every user follow-up, distinguish a correction to existing work from an independent new task. Use delegate_task action=list to find your workers, then action=steer or action=stop on the affected workers. Pass the user's latest constraints in full; preserve unrelated work. Acknowledge changes only after the control was accepted. Never claim a tool operation was undone by cancellation.
New independent tasks get their own background worker. Require workers to report verifiable artifacts and failures. Reject obsolete output after a correction; request an updated result. Use a separate background reviewer when verification requires tools. Never claim completion based only on a dispatch handle.
If background capacity or completion delivery is unavailable, report that condition and stay responsive. Do not fall back to doing the task in this chat.
"""
COORDINATION_TOOLS = frozenset({'delegate_task', 'todo', 'clarify', 'tool_search'})


def enabled(agent):
    if os.environ.get('HERMES_HOB_COORDINATOR') != '1' or getattr(agent, '_delegate_depth', 0) != 0:
        return False
    # Finite consumers (cron/one-shot jobs) must receive their result in the
    # current turn. They are execution workers, not interactive coordinators.
    from gateway.session_finite import finite_turn_required
    return finite_turn_required() is False


def prompt(agent, system_message=None):
    if not enabled(agent):
        return system_message
    if system_message and system_message.startswith(INSTRUCTIONS):
        return system_message
    return INSTRUCTIONS + ('\n' + system_message if system_message else '')


def restore_prompt(function):
    """Apply coordinator instructions after native cached-history restoration."""
    @wraps(function)
    def call(agent, *args, **kwargs):
        result = function(agent, *args, **kwargs)
        current = getattr(agent, '_cached_system_prompt', None)
        if enabled(agent) and isinstance(current, str) and INSTRUCTIONS not in current:
            agent._cached_system_prompt = INSTRUCTIONS + '\n\n' + current
            stable = getattr(agent, '_cached_system_prompt_static', None)
            if isinstance(stable, str) and stable:
                agent._cached_system_prompt_static = INSTRUCTIONS + '\n\n' + stable
        return result
    return call


def tool_block(agent, name):
    if enabled(agent) and name not in COORDINATION_TOOLS:
        return ('HOB coordinator: delegate this execution to a background subagent with '
                'delegate_task(background=true), then end your turn. Keep this chat available for the user.')
    return None


def refuse_inline(batch, reason):
    # These children were constructed but never dispatched. Release their
    # independent resources; never close an already-running sibling.
    from tools.delegate_tool_child_run import _detach_child, _signal_child_stop, _close_child
    for _, _, child in batch.children:
        _signal_child_stop(child, 'Background delegation was not admitted')
        _detach_child(batch.parent_agent, child)
        _close_child(child, 'HOB undispatched child cleanup')
    return json.dumps({'status': 'not_dispatched', 'error': 'HOB_BACKGROUND_UNAVAILABLE',
                       'reason': reason, 'message': 'No foreground fallback was run. Report the unavailable background capacity or delivery to the user.'})

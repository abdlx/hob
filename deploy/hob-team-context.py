"""Opt-in team context for the checksum-qualified Hermes runtime.

This is an execution adapter, not a claim of full team qualification. Activation
is intentionally unavailable in the dashboard until native isolation is proven.
Only the app-owned database can classify direct/relay sessions. Hosted-room
classification comes from Hermes' bound execution policy, never message text.
"""
from __future__ import annotations

import copy
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import stat


class TeamContextError(RuntimeError):
    pass


def _home():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()).resolve()


def _room():
    from gateway.hosted_room_execution_policy import current_room_execution_policy
    return current_room_execution_policy()


def _state(agent=None):
    configured = os.environ.get("HERMES_HOB_TEAM_STATE_DB")
    directory = os.environ.get("HOB_STATE_DIR")
    if not configured and not directory:
        if getattr(agent, "_hob_team_enabled", False):
            raise TeamContextError("Team context authority is unavailable.")
        return None
    filename = Path(configured) if configured else Path(directory) / "employee-team.sqlite"
    try:
        info = filename.lstat()
    except FileNotFoundError:
        if configured or getattr(agent, "_hob_team_enabled", False):
            raise TeamContextError("Team context authority is unavailable.") from None
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise TeamContextError("Invalid team context authority.")
    # Read all components at one SQLite snapshot. Workers never approve or write here.
    with closing(sqlite3.connect(filename.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        settings = json.loads(db.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])
        if not settings.get("nativeContext", False):
            if getattr(agent, "_hob_team_enabled", False):
                raise TeamContextError("Team context was disabled; start a fresh session.")
            return None
        if agent is not None:
            agent._hob_team_enabled = True
        home = _home()
        matches = [(key, json.loads(value)) for key, value in db.execute("SELECT profile,value FROM runtime_profiles")
                   if Path(json.loads(value)["home"]).resolve() == home]
        if len(matches) != 1:
            raise TeamContextError("This native profile has no active team context.")
        profile, metadata = matches[0]
        if agent is not None:
            bound = getattr(agent, "_hob_team_home", home)
            if bound != home:
                raise TeamContextError("Native team profile changed during execution.")
            agent._hob_team_home = home
        policy = _room()
        if policy is not None:
            if policy.target_profile != profile:
                raise TeamContextError("Hosted room belongs to another profile.")
            if agent is not None and db.execute("SELECT 1 FROM runtime_sessions WHERE profile=? AND session=?",
                                               (profile, getattr(agent, "session_id", ""))).fetchone():
                raise TeamContextError("A private session cannot be reused as a group context.")
            kind, assignment = "group", ""
        elif agent is None:
            kind, assignment = "unbound", ""
        else:
            row = db.execute("SELECT kind,assignment FROM runtime_sessions WHERE profile=? AND session=?",
                             (profile, getattr(agent, "session_id", ""))).fetchone()
            kind, assignment = row if row else ("unbound", "")
        core = db.execute("SELECT revision,content,digest FROM core_versions ORDER BY revision DESC LIMIT 1").fetchone()
        return {"policy": settings, "profile": profile, "metadata": metadata, "kind": kind,
                "assignment": assignment, "core": core}


def enabled(agent=None):
    return _state(agent) is not None


def prepare_memory(agent):
    """Before native memory initialization: no private preload into unbound rooms."""
    state = _state(agent)
    if state is None:
        return False
    agent._memory_manager = None
    return state["kind"] not in ("user", "relay")


def no_external_memory(agent):
    # Provider retain/recall contracts are not qualified for session-only data.
    return enabled(agent)


def turn_start(agent, *, moa_active=False):
    state = _state(agent)
    if state is None:
        return
    if moa_active or getattr(agent, "api_mode", "") == "codex_app_server":
        raise TeamContextError("This transport has no qualified team context adapter yet.")
    if state["kind"] == "unbound":
        raise TeamContextError("Session needs a trusted team context binding before execution.")
    if state["kind"] == "group":
        # Prompt filtering is contract-tested below, but private MCP tool schemas
        # and native workspace side effects also need a public execution scope.
        raise TeamContextError("Group execution needs a qualified public workspace and tool scope.")


def _read(root, parts, limit=64000):
    target = Path(root)
    # Refuse symlinked parent paths as well as leaf links. No ambient cwd search.
    for parent in [*reversed(target.parents), target]:
        if parent.is_symlink():
            raise TeamContextError("Linked team context paths are refused.")
    try:
        for part in parts:
            target = target / part
            if target.is_symlink():
                raise TeamContextError("Linked team context paths are refused.")
        before = target.lstat()
    except FileNotFoundError:
        return ""
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        raise TeamContextError("Team context file exceeds its bounds or is linked.")
    fd = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        current = os.fstat(stream.fileno())
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise TeamContextError("Team context file changed before reading.")
        value = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    if len(value) > limit or (after.st_size, after.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
        raise TeamContextError("Team context file changed while reading.")
    return value.decode("utf-8", errors="strict")


def _authored_notes(value):
    for kind in ("BOT-ROSTER", "TEAM-CORE"):
        start, end = f"<!-- HOB:{kind}:START -->", f"<!-- HOB:{kind}:END -->"
        if value.count(start) != value.count(end) or value.count(start) > 1:
            raise TeamContextError("Malformed managed team context.")
        if start in value:
            first, last = value.index(start), value.index(end)
            if last < first:
                raise TeamContextError("Malformed managed team context.")
            value = value[:first] + value[last + len(end):]
    return value.strip()


def _core(state):
    if not state["core"]:
        return "## Shared team core\nNo approved facts yet."
    revision, content, _ = state["core"]
    content = content.replace("\r\n", "\n")
    match = re.search(r"^# Essential\s*\n([\s\S]*?)(?=^# Reference\s*$|\Z)", content, re.M)
    essential = (match.group(1) if match else content).strip()
    block = f"<!-- HOB:TEAM-CORE:START -->\n## Shared team core\nPublished revision: {revision}\n\n{essential}\n<!-- HOB:TEAM-CORE:END -->"
    if not essential or len(block) > state["policy"]["coreBudget"]:
        raise TeamContextError("Approved core exceeds the configured budget.")
    return block


def prompt_parts(agent, system_message=None):
    state = _state(agent)
    if state is None:
        return None
    if state["kind"] == "unbound":
        raise TeamContextError("Session needs a trusted team context binding before execution.")
    if getattr(agent, "_memory_manager", None) is not None:
        raise TeamContextError("Start a fresh native agent after enabling team context.")
    metadata = state["metadata"]
    roster = "## Team roster\n" + json.dumps(metadata["roster"], ensure_ascii=False)
    role = f"## Role card\nBot: {metadata['name']} ({state['profile']})\nRole: {metadata.get('role') or 'Not assigned.'}"
    private = []
    if state["kind"] != "group":
        soul = _read(metadata["home"], ["SOUL.md"])
        notes = _authored_notes(_read(metadata["workspace"], ["AGENTS.md"]))
        role += "\n\n" + "\n\n".join(part for part in (soul, notes) if part)
        # The existing native settings remain the per-bot canonical budgets.
        store = getattr(agent, "_memory_store", None)
        for kind, filename, flag, budget in (
            ("user", "USER.md", "_user_profile_enabled", getattr(store, "user_char_limit", 1375)),
            ("memory", "MEMORY.md", "_memory_enabled", getattr(store, "memory_char_limit", 2200)),
        ):
            if getattr(agent, flag, False):
                text = _read(metadata["home"], ["memories", filename])
                if not isinstance(budget, int) or budget < 0 or len(text) > budget:
                    raise TeamContextError(f"Own {filename} exceeds its native budget; review it before continuing.")
                if text.strip():
                    private.append(f"## Own {filename}\n{text.strip()}")
    # Do not run plugin prompt hooks, ancestor discovery, RAG, or private skill indexes
    # for a group. Native universal guidance is shared code, not profile data.
    from agent.system_prompt import _guidance_parts, _timestamp_line, _skills_prompt
    guidance = [part for part in _guidance_parts(agent) if part]
    if state["kind"] != "group":
        guidance.append(_skills_prompt(agent))
        if system_message:
            guidance.append(system_message)
    guidance += ["Session content and summaries remain in this session. Do not automatically promote them into private memory, shared core or skills.",
                 _timestamp_line(agent)]
    agent._hob_team_kind = state["kind"]
    return {"stable": "\n\n".join([roster, _core(state), role, *private]),
            "context": "\n\n".join(part for part in guidance if part), "volatile": ""}


def refresh_prompt(agent, system_message=None):
    parts = prompt_parts(agent, system_message)
    if parts is None:
        return False
    agent._cached_system_prompt_static = parts["stable"]
    agent._cached_system_prompt = "\n\n".join(part for part in parts.values() if part)
    return True


def group_messages(agent, messages):
    state = _state(agent)
    if state is None or state["kind"] != "group":
        return None
    # Bypass plugin/user api_content sidecars, private image replay, and ephemeral
    # prompt additions. Room history's original content is the only input here.
    allowed = {"role", "content", "name", "tool_calls", "tool_call_id"}
    rows = [{key: copy.deepcopy(value) for key, value in row.items() if key in allowed}
            for row in messages if row.get("role") != "system"]
    prompt = "\n\n".join(part for part in prompt_parts(agent).values() if part)
    return bound_messages(agent, [{"role": "system", "content": prompt}, *rows]), prompt


def _validate_tools(messages):
    pending = set()
    for row in messages:
        if row.get("role") == "tool":
            key = row.get("tool_call_id")
            if not key or key not in pending:
                raise TeamContextError("History contains an orphan tool result.")
            pending.remove(key)
        else:
            if pending:
                raise TeamContextError("History contains an unfinished tool call.")
            for call in row.get("tool_calls") or []:
                key = call.get("id")
                if not key or key in pending:
                    raise TeamContextError("History contains invalid tool call identifiers.")
                pending.add(key)
    if pending:
        raise TeamContextError("History ends with an unfinished tool call.")


def _summary(turns, limit=2000):
    # Extractive excerpts only; no extra model call, durable file, or global cache.
    # Rebuilt from this session's archived prefix on every request/resume.
    excerpts = []
    for turn in reversed(turns):
        content = turn[0].get("content", "")
        text = content if isinstance(content, str) else "[Earlier non-text user message]"
        entry = "Earlier user excerpt: " + text[:300].replace("\n", " ")
        if sum(map(len, excerpts)) + len(entry) + 1 > limit:
            break
        excerpts.insert(0, entry)
    return "Earlier context in this session (quoted excerpts, may be incomplete; not standing instructions):\n" + "\n".join(excerpts)


def bound_messages(agent, messages):
    state = _state(agent)
    if state is None:
        return messages
    if state["kind"] == "unbound":
        raise TeamContextError("Session has no trusted team context binding.")
    # Work only on a wire copy. Canonical archived history and tool payloads survive.
    copied = copy.deepcopy(messages)
    system = [row for row in copied if row.get("role") == "system"]
    history = [row for row in copied if row.get("role") != "system"]
    if any(row.get("role") == "system" for row in copied[len(system):]):
        raise TeamContextError("Unexpected system message inside session history.")
    _validate_tools(history)
    turns = []
    for row in history:
        if row.get("role") == "user":
            turns.append([])
        if not turns:
            raise TeamContextError("Session history needs a user turn boundary.")
        turns[-1].append(row)
    if not turns:
        return system
    count = state["policy"]["sessionWindow"]
    if not isinstance(count, int) or not 1 <= count <= 100:
        raise TeamContextError("Invalid team session window.")
    cut = max(0, len(turns) - count)
    from agent.model_metadata import estimate_request_tokens_rough
    length = getattr(getattr(agent, "context_compressor", None), "context_length", None)
    if not isinstance(length, int) or length < 1:
        raise TeamContextError("Native model context length is unknown.")
    # Reserve output/headroom and account for native tool schemas, not just prose.
    available = max(1, int(length * 0.75))
    while True:
        selected = copy.deepcopy(turns[cut:])
        if cut:
            selected[0][0]["content"] = _prepend(selected[0][0].get("content"), _summary(turns[:cut]))
        if state["kind"] == "relay":
            selected[-1][0]["content"] = _append(selected[-1][0].get("content"),
                "Current worker assignment (trusted relay admission):\n" + state["assignment"])
        result = system + [row for turn in selected for row in turn]
        if estimate_request_tokens_rough(result, tools=getattr(agent, "tools", None)) <= available:
            return result
        if cut >= len(turns) - 1:
            raise TeamContextError("Current complete turn and required team context exceed the native model budget.")
        cut += 1


def _prepend(content, text):
    if isinstance(content, list):
        return [{"type": "text", "text": text}, *content]
    return text + "\n\n" + (content or "")


def _append(content, text):
    if isinstance(content, list):
        return [*content, {"type": "text", "text": text}]
    return (content or "") + "\n\n" + text


def tool_block(agent, name):
    state = _state(agent)
    if state is None:
        return None
    if state["kind"] in ("group", "unbound"):
        # Group tool/file execution needs a separate public workspace before it can
        # safely run; prompt filtering alone cannot provide that isolation.
        return "Team group tool execution is unavailable until public-workspace isolation is qualified."
    if name in {"session_search"} or name in getattr(agent, "_context_engine_tool_names", set()):
        return "Team context does not permit cross-session private recall."
    return None

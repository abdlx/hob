"""Install team hooks only onto the exact runtime pinned by the image."""
import ast
import hashlib
from pathlib import Path


SOURCES = {
    "agent/agent_init.py": "29be7ec99508cb1d82685a4d535b63977dd671a43b4bef910426291d40df4da5",
    "agent/conversation_loop.py": "5a2b1973189300f0f07a990e39c6f5ddf200288aaec1032205685bef3437e4bf",
    "agent/system_prompt.py": "f804c92ddc7197ad2483960f07d7c2545c163644085b1821ce22bdad8c7f8597",
    "agent/turn_context.py": "800fdfe776113120cdd0f0d454f5e7f1c68c4573fcf985980b5e6a873ec22a04",
    "agent/chat_completion_helpers.py": "8e4348884b780999fd33ddaecca688f1afcfe4f66940b5bac62c222383c41869",
    "agent/agent_runtime_helpers.py": "295bd0adcb698ddeb87966f77a79ef1c8016702641db401bfe692ffb63e0dd49",
    "run_agent.py": "2bd45c545c2cf0dec95702e71232f026b1265b54bf234a1c03c8cf83f5236f10",
    "agent/turn_context_compaction.py": "5bff21fbe3a7064f0e12b61f336b717bc59ae0bab5f5384b775f0e99b4355bd1",
    "agent/turn_preflight.py": "5909b32461c37fa50afd4b537f84e120f14bad22bbb9c5f0f197d9ec6bdfb0b4",
    "agent/conversation_compression.py": "490af3443334af9dd8ec011b9d5d8f483ec4c13e88510d141fc76b52f93c6fa2",
    "agent/turn_finalizer.py": "9000e17a4a0dba03b1d97cc10fe4184addcca685520ca0c9e6c6ef2cb97d1f25",
    "agent/turn_request_assembly.py": "61b6a0022037d0dfb004f71e3b085b21d3b03e83bde5478b6ee67c8a0118723a",
    "agent/client_lifecycle.py": "4e8a80556184c415256934c50e6191b840910867fe68d36efc263440ea7b7dd2",
    "agent/auxiliary_client.py": "62d0fbcc689cd8e45ee8dd43cea583645a4ab1962613438abd9ae564218b507d",
    "agent/api_error_summary.py": "b31ba3cc4081d8e2e68d599410e5e5cd01204a9bf46dfdedefd64d7e9177f3f9",
    "tools/write_approval.py": "8d8a15d29a73dceb2e8cf76f613d59d91115314c908a8086ffe1c72572382c7f",
    "tools/memory_tool.py": "3ac1975d5d34a8e0fd20ea538aa084fc48c5ba21e8b2da4f97f58a7bf3cafaab",
    "tools/skill_manager_tool.py": "131d3720957659c37addd27430693d5d0b7dec0b5176a83b2bedad783b7edcd7",
    "agent/skill_utils.py": "9cb773037fe97940cdfcbf8b0d6bbfe60e366985749d3ae3bec3b274a83e33c4",
    "hermes_cli/write_approval_commands.py": "f861762fed993aedbdd3a1dc95862d6237e881b9e159fe205193925a7d32a3d4",
    "agent/inline_tool_executors.py": "20ec06265f1629b32a932a1abc892e0965baac39f79719f99aec651ff44a7065",
}


def _entry(source, name, body):
    matches = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(matches) != 1:
        raise RuntimeError("Expected one qualified team hook: " + name)
    node = matches[0]
    first = node.body[0]
    doc = isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str)
    line = first.end_lineno if doc else first.lineno - 1
    indent = " " * (node.col_offset + 4)
    lines = source.splitlines(keepends=True)
    lines.insert(line, "".join(indent + value + "\n" for value in body.splitlines()))
    return "".join(lines)


def _replace(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError("Expected one qualified team call site.")
    return source.replace(before, after)


def _client_factory(source, name, *, agent_arg=False):
    matches = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(matches) != 1:
        raise RuntimeError("Expected one qualified model client factory: " + name)
    node = matches[0]
    lines = source.splitlines(keepends=True)
    # Static qualified module, installed below. No dynamic provider/plugin import.
    lines.insert(node.lineno - 1, " " * node.col_offset + "@__import__('agent.hob_team_execution', fromlist=['client_factory']).client_factory(agent_arg=" + str(agent_arg) + ")\n")
    return "".join(lines)


def revisions(sources):
    out = dict(sources)
    key = "agent/agent_init.py"
    out[key] = _replace(out[key], "    agent._iters_since_skill = 0\n", """    agent._iters_since_skill = 0
    from agent import hob_team_context as _hob_team
    if _hob_team.prepare_memory(agent):
        return
""")
    out[key] = _replace(out[key], "    # External memory provider plugin (one at a time, alongside built-in): memory.provider.\n", """    if _hob_team.no_external_memory(agent):
        agent._memory_manager = None
        return
    # External memory provider plugin (one at a time, alongside built-in): memory.provider.
""")
    out[key] = _entry(out[key], "_select_context_engine", """from agent import hob_team_context as _hob_team
if _hob_team.enabled():
    return None""")
    key = "agent/system_prompt.py"
    out[key] = _entry(out[key], "build_system_prompt_parts", """from agent import hob_team_context as _hob_team
_hob_parts = _hob_team.prompt_parts(agent, system_message)
if _hob_parts is not None:
    return _hob_parts""")
    key = "agent/conversation_loop.py"
    out[key] = _entry(out[key], "_restore_or_build_system_prompt", """from agent import hob_team_context as _hob_team
if _hob_team.refresh_prompt(agent, system_message):
    _persist_system_prompt(agent, 'Team prompt persistence failed', persist_tools=True)
    return""")
    key = "agent/turn_context.py"
    out[key] = _entry(out[key], "build_turn_context", """from agent import hob_team_context as _hob_team
_hob_team.turn_start(agent, moa_active=moa_active)""")
    out[key] = _replace(out[key], "    if agent._cached_system_prompt is None:\n", "    if _hob_team.enabled(agent) or agent._cached_system_prompt is None:\n")
    for name, result in (("_tick_memory_nudge", "False"), ("_collect_pre_llm_call_context", "''"), ("_memory_turn_start_and_prefetch", "''"), ("_merge_gateway_notes", "plugin_user_context")):
        out[key] = _entry(out[key], name, f"""from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    return {result}""")
    out[key] = _replace(out[key], "    stage_skills_index_note(agent, active_system_prompt, messages)\n", "    if not _hob_team.enabled(agent):\n        stage_skills_index_note(agent, active_system_prompt, messages)\n")
    out[key] = _entry(out[key], "build_api_messages", """from agent import hob_team_context as _hob_team
_hob_group = _hob_team.group_messages(agent, messages)
if _hob_group is not None:
    return _hob_group""")
    out[key] = _replace(out[key], "    return api_messages, effective_system\n", """    api_messages = _hob_team.bound_messages(agent, api_messages)
    return api_messages, effective_system
""")
    key = "agent/chat_completion_helpers.py"
    # This fallback creates its own request instead of calling build_api_messages.
    out[key] = _entry(out[key], "_iteration_summary_api_messages", """from agent import hob_team_context as _hob_team
_hob_group = _hob_team.group_messages(agent, messages)
if _hob_group is not None:
    return _hob_group[0]""")
    tree = ast.parse(out[key])
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_iteration_summary_api_messages")
    returns = [node for node in ast.walk(function) if isinstance(node, ast.Return) and isinstance(node.value, ast.Name) and node.value.id == "api_messages"]
    if len(returns) != 1:
        raise RuntimeError("Expected one qualified summary request return.")
    lines = out[key].splitlines(keepends=True)
    lines[returns[0].lineno - 1] = "    return _hob_team.bound_messages(agent, api_messages)\n"
    out[key] = "".join(lines)
    key = "agent/agent_runtime_helpers.py"
    out[key] = _entry(out[key], "_pre_tool_block_message", """from agent import hob_team_context as _hob_team
_hob_block = _hob_team.tool_block(agent, function_name)
if _hob_block:
    return _hob_block, function_args""")
    key = "run_agent.py"
    # Check both enqueue and execution so an already queued idle review cannot bypass it.
    for name in ("_spawn_background_review", "_spawn_background_review_now", "shutdown_memory_provider", "commit_memory_session", "_sync_external_memory_for_turn"):
        out[key] = _entry(out[key], name, """from agent import hob_team_context as _hob_team
if _hob_team.no_external_memory(self):
    return""")
    # Team history is an archived transcript plus a request-local projection.
    # Do not feed that archive to native summary/rotation or micro-compaction.
    key = "agent/turn_context_compaction.py"
    out[key] = _entry(out[key], "run_turn_start_compaction", """from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    return CompactionOutcome(messages=messages, active_system_prompt=active_system_prompt,
        conversation_history=conversation_history, current_turn_user_idx=current_turn_user_idx)""")
    key = "agent/turn_preflight.py"
    out[key] = _entry(out[key], "run_preflight_compression", """from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    if provider_overflow_preflight or v._provider_overflow_recovery_pending:
        raise _hob_team.TeamContextError('The provider rejected the bounded team request; native archive compression is unavailable.')
    v.action, v.result = 'fallthrough', None
    return v""")
    out[key] = _entry(out[key], "compress_after_tool_results", """from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    return PostToolCompressionVerdict(end_turn=False, messages=messages,
        active_system_prompt=active_system_prompt, conversation_history=conversation_history,
        compression_attempts=compression_attempts, final_response=final_response,
        turn_exit_reason=turn_exit_reason, current_turn_user_idx=current_turn_user_idx)""")
    key = "agent/conversation_compression.py"
    out[key] = _entry(out[key], "compress_context", """from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    raise _hob_team.TeamContextError('Team context uses a bounded session projection; native archive compression and rotation are unavailable.')""")
    out[key] = _entry(out[key], "recover_rotated_compression_session", """from agent import hob_team_context as _hob_team
if _hob_team.enabled(agent):
    _hob_db = getattr(agent, '_session_db', None)
    _hob_session = getattr(agent, 'session_id', None)
    if _hob_db is not None and _hob_session and _session_was_rotated_by_compression(_hob_db, _hob_session):
        raise _hob_team.TeamContextError('This session was rotated outside team context; a trusted session binding is required.')
    return None""")
    key = "agent/turn_finalizer.py"
    out[key] = _entry(out[key], "_micro_compact_after_turn", """from agent import hob_team_context as _hob_team
try:
    _hob_skip_compaction = _hob_team.enabled(agent)
except Exception:
    # This cleanup runs immediately before archive persistence. Authority failure
    # must suppress compaction without also losing the turn's durable transcript.
    logger.warning('Team authority unavailable; skipped archive micro-compaction.')
    return
if _hob_skip_compaction:
    return""")
    key = "agent/turn_request_assembly.py"
    out[key] = _replace(out[key], "    return AssembledRequest(\n", """    from agent import hob_team_context as _hob_team
    _hob_team.check_request_budget(agent, api_messages, tools_for_api, effective_system)
    return AssembledRequest(
""")
    key = "agent/client_lifecycle.py"
    for name in ("_create_request_openai_client", "_create_request_anthropic_client"):
        out[key] = _client_factory(out[key], name, agent_arg=True)
    key = "agent/auxiliary_client.py"
    for name in ("resolve_provider_client", "get_text_auxiliary_client", "resolve_vision_provider_client", "_get_cached_client", "_to_async_client"):
        out[key] = _client_factory(out[key], name)
    key = "agent/chat_completion_helpers.py"
    for name in ("_dispatch_nonstreaming_api_request", "interruptible_streaming_api_call"):
        out[key] = _entry(out[key], name, """from agent import hob_team_execution as _hob_execution
_hob_execution.require_supported_transport(agent)""")
    key = "agent/api_error_summary.py"
    out[key] = _entry(out[key], "_summarize_api_error", """from agent import hob_team_context as _hob_team
_hob_refusal = _hob_team.explain_error(error)
if _hob_refusal is not None:
    return _hob_refusal""")
    key = "tools/write_approval.py"
    out[key] = _entry(out[key], "evaluate_gate", """from agent import hob_team_retention as _hob_retention
_hob_decision = _hob_retention.decision(subsystem, GateDecision)
if _hob_decision is not None:
    return _hob_decision""")
    out[key] = _entry(out[key], "stage_write", """from agent import hob_team_retention as _hob_retention
_hob_record = _hob_retention.stage_write(subsystem, payload, summary=summary, origin=origin)
if _hob_record is not None:
    return _hob_record""")
    # Native tool owners historically fail open when this optional gate cannot
    # import. Team authority makes that absence a refusal, never a direct write.
    for key, before in (("tools/memory_tool.py", "    except Exception:\n        return None\n    decision = wa.evaluate_gate(wa.MEMORY, inline_summary=summary, inline_detail=detail)\n"),
                        ("tools/skill_manager_tool.py", "    except Exception:\n        return None  # fail open\n    decision = wa.evaluate_gate(wa.SKILLS)\n")):
        after = before.replace("        return None", "        from agent import hob_team_context as _hob_team\n        if _hob_team.enabled():\n            raise _hob_team.TeamContextError('The native private-write review gate is unavailable.')\n        return None", 1)
        out[key] = _replace(out[key], before, after)
    key = "tools/memory_tool.py"
    gate = next(node for node in ast.walk(ast.parse(out[key])) if isinstance(node, ast.FunctionDef) and node.name == "_gate_or_stage")
    lines = out[key].splitlines(keepends=True)
    lines.insert(gate.lineno - 1, "@__import__('agent.hob_team_retention', fromlist=['memory_gate']).memory_gate\n")
    out[key] = "".join(lines)
    key = "agent/inline_tool_executors.py"
    out[key] = _entry(out[key], "emit_terminal_post_tool_call", """from agent import hob_team_retention as _hob_retention
_hob_retention.observe_tool(agent, function_name, status)""")
    key = "agent/skill_utils.py"
    out[key] = _entry(out[key], "get_skill_search_roots", """from agent import hob_team_retention as _hob_retention
_hob_root = _hob_retention.private_skill_root()
if _hob_root is not None:
    return [(TIER_LOCAL, _hob_root)]""")
    for name, result in (("get_skill_create_dir", "None"), ("get_external_skills_dirs", "[]"), ("get_project_skills_dirs", "[]"), ("get_untrusted_project_skills_root", "None")):
        out[key] = _entry(out[key], name, f"""from agent import hob_team_retention as _hob_retention
if _hob_retention.private_skill_root() is not None:
    return {result}""")
    key = "tools/skill_manager_tool.py"
    out[key] = _entry(out[key], "_resolve_skill_dir", """from agent import hob_team_retention as _hob_retention
_hob_root = _hob_retention.private_skill_root()
if _hob_root is not None:
    return _hob_root / (category or '') / name""")
    out[key] = _entry(out[key], "_find_skill_in_other_profiles", """from agent import hob_team_retention as _hob_retention
if _hob_retention.private_skill_root() is not None:
    return []""")
    key = "hermes_cli/write_approval_commands.py"
    tree = ast.parse(out[key])
    apply = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_apply_one")
    lines = out[key].splitlines(keepends=True)
    lines.insert(apply.lineno - 1, "@__import__('agent.hob_team_retention', fromlist=['review_application']).review_application\n")
    out[key] = "".join(lines)
    key = "agent/conversation_loop.py"
    tree = ast.parse(out[key])
    turn = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "_run_conversation_turn")
    lines = out[key].splitlines(keepends=True)
    lines.insert(turn.lineno - 1, "@__import__('agent.hob_team_retention', fromlist=['turn_scope']).turn_scope\n")
    out[key] = "".join(lines)
    for text in out.values():
        ast.parse(text)
    return out


def install(root, expected=None):
    root = Path(root)
    expected = SOURCES if expected is None else expected
    source = {}
    # Validate the entire set before mutating anything, including repeat installs.
    for relative, digest in expected.items():
        target = root / relative
        if target.is_symlink() or not target.is_file():
            raise RuntimeError("Missing qualified team source: " + relative)
        raw = target.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError("Team source differs from the qualified upstream commit: " + relative)
        source[relative] = raw.decode("utf-8")
    helpers = {"agent/hob_team_context.py": "hob-team-context.py", "agent/hob_team_execution.py": "hob-team-execution.py", "agent/hob_team_retention.py": "hob-team-retention.py"}
    for relative in helpers:
        helper = root / relative
        if helper.exists() or helper.is_symlink():
            raise RuntimeError("Refusing to replace an existing team adapter module.")
    updated = revisions(source)
    helper_bytes = {relative: Path(__file__).with_name(filename).read_bytes() for relative, filename in helpers.items()}
    for value in helper_bytes.values():
        ast.parse(value)
    for relative, text in updated.items():
        (root / relative).write_bytes(text.encode("utf-8"))
    for relative, value in helper_bytes.items():
        helper = root / relative
        helper.write_bytes(value)
        helper.chmod(0o444)
    return {relative: hashlib.sha256(text.encode("utf-8")).hexdigest() for relative, text in updated.items()} | {relative: hashlib.sha256(value).hexdigest() for relative, value in helper_bytes.items()}

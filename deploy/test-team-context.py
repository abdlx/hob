"""Local adapter contract tests; optional exact-source hook execution probes.

HOB_QUALIFIED_RUNTIME points at a clean checkout of the image's pinned Hermes
commit. These tests do not attest Linux tool isolation or a live employee team.
"""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import __future__


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


team = load("team", "hob-team-context.py")
compat = load("compat", "apply-hermes-team-compat.py")


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hob-native-team-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "native" / "profiles" / "writer"
        self.workspace = self.root / "workspaces" / "bots" / "writer"
        (self.home / "memories").mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.db = sqlite3.connect(self.root / "employee-team.sqlite")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_profiles(profile TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_sessions(profile TEXT,session TEXT,kind TEXT,assignment TEXT);
            CREATE TABLE core_versions(revision INTEGER,content TEXT,digest TEXT);
        """)
        self.policy = {"nativeContext": True, "sessionWindow": 20, "coreBudget": 4000}
        self.db.execute("INSERT INTO settings VALUES(1,?)", (json.dumps(self.policy),))
        self.db.execute("INSERT INTO runtime_profiles VALUES(?,?)", ("writer", json.dumps({
            "name": "My own writer", "role": "Draft public documents", "home": str(self.home),
            "workspace": str(self.workspace), "roster": [{"id": "writer", "name": "My own writer"}]})))
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','user-1','user','')")
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','relay-1','relay','TASK: assigned-work')")
        self.db.execute("INSERT INTO core_versions VALUES(1,?, 'digest')", ("# Essential\nCORE_INITIAL\n# Reference\nREFERENCE_ONLY",))
        self.db.commit()
        self.agent = types.SimpleNamespace(session_id="user-1", _memory_manager=None, _memory_store=types.SimpleNamespace(user_char_limit=1375, memory_char_limit=2200),
            _user_profile_enabled=True, _memory_enabled=True, context_compressor=types.SimpleNamespace(context_length=32000), tools=[])
        self.room = None
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HOB_STATE_DIR": str(self.root), "HERMES_HOB_TEAM_STATE_DB": ""}).start()
        patch.object(team, "_home", side_effect=lambda: self.home).start()
        patch.object(team, "_room", side_effect=lambda: self.room).start()
        # Stubs are explicit: this suite tests adapter contracts. The optional
        # qualified-source probes below execute the actual patched entry functions.
        native_prompt = types.ModuleType("agent.system_prompt")
        native_prompt._guidance_parts = lambda agent: ["Native guidance"]
        native_prompt._timestamp_line = lambda agent: "Native clock"
        native_prompt._skills_prompt = lambda agent: "OWN_SKILLS_INDEX"
        metadata = types.ModuleType("agent.model_metadata")
        metadata.estimate_request_tokens_rough = lambda rows, tools=None, system_prompt="": len(json.dumps(rows)) // 4 + len(json.dumps(tools or [])) // 4 + len(system_prompt) // 4
        package = types.ModuleType("agent")
        package.hob_team_context = team
        patch.dict(sys.modules, {"agent": package, "agent.system_prompt": native_prompt, "agent.model_metadata": metadata}).start()
        package.hob_team_retention = load("retention", "hob-team-retention.py")
        (self.home / "SOUL.md").write_text("OWN_ROLE", encoding="utf-8")
        (self.home / "memories" / "USER.md").write_text("OWN_USER", encoding="utf-8")
        (self.home / "memories" / "MEMORY.md").write_text("OWN_MEMORY", encoding="utf-8")
        (self.workspace / "AGENTS.md").write_text("<!-- HOB:BOT-ROSTER:START -->\nOUTDATED_ROSTER\n<!-- HOB:BOT-ROSTER:END -->\n<!-- HOB:TEAM-CORE:START -->\nUNAPPROVED_CORE\n<!-- HOB:TEAM-CORE:END -->\nOWN_NOTES", encoding="utf-8")

    def prompt(self):
        return "\n\n".join(team.prompt_parts(self.agent).values())

    def test_fixed_order_private_budgets_and_current_core_after_restart(self):
        prompt = self.prompt()
        markers = ["## Team roster", "CORE_INITIAL", "## Role card", "OWN_ROLE", "OWN_NOTES", "OWN_USER", "OWN_MEMORY"]
        self.assertEqual(sorted(prompt.index(value) for value in markers), [prompt.index(value) for value in markers])
        for forbidden in ("REFERENCE_ONLY", "OUTDATED_ROSTER", "UNAPPROVED_CORE"):
            self.assertNotIn(forbidden, prompt)
        team.refresh_prompt(self.agent)
        self.db.execute("INSERT INTO core_versions VALUES(2,'CORE_NEXT','digest2')")
        self.db.commit()
        team.refresh_prompt(self.agent)
        self.assertIn("CORE_NEXT", self.agent._cached_system_prompt)
        restarted = copy.copy(self.agent)
        restarted._cached_system_prompt = "LEGACY_PRIVATE_CACHE"
        self.assertTrue(team.refresh_prompt(restarted))
        self.assertNotIn("LEGACY_PRIVATE_CACHE", restarted._cached_system_prompt)
        (self.home / "memories" / "USER.md").write_text("x" * 1376, encoding="utf-8")
        with self.assertRaisesRegex(team.TeamContextError, "native budget"):
            self.prompt()

    def test_group_never_reads_private_files_or_plugin_sidecars(self):
        self.room = types.SimpleNamespace(target_profile="writer")
        self.agent.session_id = "room-1"
        with patch.object(team, "_read", side_effect=AssertionError("Private file read in group")):
            prompt = self.prompt()
            for marker in ("OWN_ROLE", "OWN_USER", "OWN_MEMORY", "OWN_NOTES", "OWN_SKILLS_INDEX"):
                self.assertNotIn(marker, prompt)
            self.assertIn("Draft public documents", prompt)
            self.assertTrue(team.prepare_memory(self.agent))
            rows, system = team.group_messages(self.agent, [
                {"role": "system", "content": "PRIVATE_CACHED_PROMPT"},
                {"role": "user", "content": "Public room question", "api_content": "PRIVATE_PLUGIN_SIDECAR"}])
            self.assertNotIn("PRIVATE_", json.dumps(rows))
            self.assertIn("Public room question", json.dumps(rows))
            self.assertEqual(rows[0]["content"], system)
        self.assertIn("public-workspace", team.tool_block(self.agent, "terminal"))
        with self.assertRaisesRegex(team.TeamContextError, "public workspace and tool scope"):
            team.turn_start(self.agent)
        self.room.target_profile = "other"
        with self.assertRaisesRegex(team.TeamContextError, "another profile"):
            self.prompt()

    def test_group_cannot_reuse_a_private_session_or_message_classification(self):
        self.room = types.SimpleNamespace(target_profile="writer")
        with self.assertRaisesRegex(team.TeamContextError, "private session"):
            self.prompt()
        self.room = None
        self.agent.session_id = "unbound-room"
        with self.assertRaisesRegex(team.TeamContextError, "trusted team context"):
            self.prompt()
        self.assertTrue(team.prepare_memory(self.agent))
        self.agent.session_id = "user-1"
        self.assertFalse(team.prepare_memory(self.agent))
        self.assertIn("cross-session", team.tool_block(self.agent, "session_search"))

    @staticmethod
    def history(count):
        result = [{"role": "system", "content": "Required system context"}]
        for index in range(count):
            result.extend([{"role": "user", "content": f"Question {index}"},
                {"role": "assistant", "tool_calls": [{"id": f"call-{index}", "function": {"name": "read_file", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": f"call-{index}", "content": "File contents"},
                {"role": "assistant", "content": f"Answer {index}"}])
        return result

    def test_twenty_complete_turns_summary_stays_local_and_archive_unchanged(self):
        messages = self.history(25)
        original = copy.deepcopy(messages)
        files = {str(file): file.read_bytes() for file in self.home.rglob("*.md")}
        result = team.bound_messages(self.agent, messages)
        self.assertEqual(sum(row["role"] == "user" for row in result), 20)
        self.assertIn("Earlier context in this session", result[1]["content"])
        self.assertEqual(messages, original)
        team._validate_tools(result[1:])
        self.assertEqual(files, {str(file): file.read_bytes() for file in self.home.rglob("*.md")})
        self.assertNotIn("Question 0", json.dumps(team.bound_messages(self.agent, [{"role": "user", "content": "Fresh turn"}])) )
        self.agent.session_id = "relay-1"
        result = team.bound_messages(self.agent, self.history(21))
        last = [row for row in result if row["role"] == "user"][-1]["content"]
        self.assertTrue(last.endswith("TASK: assigned-work"))
        self.assertEqual(json.dumps(result).count("TASK: assigned-work"), 1)

    def test_context_pressure_drops_whole_turns_and_never_truncates_required_context(self):
        self.agent.context_compressor.context_length = 1800
        result = team.bound_messages(self.agent, self.history(25))
        self.assertLess(sum(row["role"] == "user" for row in result), 20)
        self.assertEqual(result[0]["content"], "Required system context")
        team._validate_tools(result[1:])
        self.agent.context_compressor.context_length = 10
        with self.assertRaisesRegex(team.TeamContextError, "exceed"):
            team.bound_messages(self.agent, self.history(1))
        for rows in ([{"role": "user", "content": "Q"}, {"role": "tool", "tool_call_id": "missing", "content": "bad"}], self.history(1)[:-2]):
            with self.assertRaisesRegex(team.TeamContextError, "tool"):
                team.bound_messages(self.agent, rows)

    def test_final_request_budget_includes_middleware_tools_and_system_once(self):
        rows = team.bound_messages(self.agent, self.history(25))
        original = copy.deepcopy(rows)
        team.check_request_budget(self.agent, rows, self.agent.tools, "Required system context")
        self.assertEqual(rows, original)
        with self.assertRaisesRegex(team.TeamContextError, "complete-turn window"):
            team.check_request_budget(self.agent, rows + [{"role": "user", "content": "Late extra turn"}], [])
        with self.assertRaisesRegex(team.TeamContextError, "middleware and tools"):
            team.check_request_budget(self.agent, rows, [{"description": "X" * 100000}])
        with self.assertRaisesRegex(team.TeamContextError, "middleware and tools"):
            team.check_request_budget(self.agent, rows + [{"role": "assistant", "content": "X" * 100000}], [])
        estimator = sys.modules["agent.model_metadata"].estimate_request_tokens_rough
        with patch.object(sys.modules["agent.model_metadata"], "estimate_request_tokens_rough", wraps=estimator) as observed:
            team.check_request_budget(self.agent, rows, [], "Required system context")
            self.assertEqual(observed.call_args.kwargs["system_prompt"], "")
            team.check_request_budget(self.agent, rows[1:], [], "Separate system")
            self.assertEqual(observed.call_args.kwargs["system_prompt"], "Separate system")
        self.agent.session_id = "unbound"
        with self.assertRaisesRegex(team.TeamContextError, "trusted team context"):
            team.check_request_budget(self.agent, [], [])

    def test_revoked_profiles_missing_authority_and_unqualified_transports_fail_closed(self):
        team.turn_start(self.agent)
        for name in ("codex_app_server",):
            self.agent.api_mode = name
            with self.assertRaisesRegex(team.TeamContextError, "transport"):
                team.turn_start(self.agent)
        self.agent.api_mode = "chat_completions"
        with self.assertRaisesRegex(team.TeamContextError, "transport"):
            team.turn_start(self.agent, moa_active=True)
        self.db.execute("DELETE FROM runtime_profiles")
        self.db.commit()
        with self.assertRaisesRegex(team.TeamContextError, "active team context"):
            team.refresh_prompt(self.agent)
        with patch.dict(os.environ, {"HOB_STATE_DIR": str(self.root / 'missing')}):
            with self.assertRaisesRegex(team.TeamContextError, "unavailable"):
                team.enabled(self.agent)
        # The runtime gets only a configured DB path. Even a fresh agent must
        # refuse a missing authority instead of silently reverting to legacy.
        with patch.dict(os.environ, {"HERMES_HOB_TEAM_STATE_DB": str(self.root / 'missing.sqlite')}):
            with self.assertRaisesRegex(team.TeamContextError, "unavailable"):
                team.enabled(types.SimpleNamespace())

    def test_ordinary_mode_is_a_noop_and_cannot_be_silently_resumed_after_revocation(self):
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),))
        self.db.commit()
        self.assertFalse(team.enabled(self.agent))
        self.assertIsNone(team.prompt_parts(self.agent))
        self.assertFalse(team.prepare_memory(self.agent))
        messages = self.history(25)
        self.assertIs(team.bound_messages(self.agent, messages), messages)
        self.agent._hob_team_enabled = True
        with self.assertRaisesRegex(team.TeamContextError, "disabled"):
            team.refresh_prompt(self.agent)

    @unittest.skipUnless(os.environ.get("HOB_QUALIFIED_RUNTIME"), "Exact pinned source checkout not supplied")
    def test_full_image_installer_produces_auditable_manifest_on_pinned_source(self):
        source_root = Path(os.environ["HOB_QUALIFIED_RUNTIME"])
        destination = self.root / "image-runtime"
        files = [*compat.SOURCES, "gateway/run_goals.py", "hermes_cli/web_routers/skills.py", "hermes_time.py", "tools/browser_tool.py"]
        for relative in files:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source_root / relative).read_bytes())
        script = Path(__file__).with_name("apply-hermes-compat.py")
        result = subprocess.run([sys.executable, "-I", str(script), str(destination)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((destination / "hob-compat.json").read_text())
        self.assertEqual(manifest["upstream"], "7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357")
        for relative, digest in manifest["team_context_v1"].items():
            self.assertEqual(hashlib.sha256((destination / relative).read_bytes()).hexdigest(), digest)

    @unittest.skipUnless(os.environ.get("HOB_QUALIFIED_RUNTIME"), "Exact pinned source checkout not supplied")
    def test_actual_pinned_source_installs_once_and_executes_critical_hooks(self):
        source_root = Path(os.environ["HOB_QUALIFIED_RUNTIME"])
        destination = self.root / "qualified"
        for relative, digest in compat.SOURCES.items():
            raw = (source_root / relative).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        before = {relative: (destination / relative).read_bytes() for relative in compat.SOURCES}
        changed_file = destination / "run_agent.py"
        changed_file.write_bytes(before["run_agent.py"] + b"\n# Unknown upstream edit\n")
        with self.assertRaisesRegex(RuntimeError, "differs"):
            compat.install(destination)
        for relative in compat.SOURCES:
            if relative != "run_agent.py":
                self.assertEqual(before[relative], (destination / relative).read_bytes())
        changed_file.write_bytes(before["run_agent.py"])
        hashes = compat.install(destination)
        self.assertEqual(len(hashes), len(compat.SOURCES) + 3)
        with self.assertRaisesRegex(RuntimeError, "differs"):
            compat.install(destination)

        def function(relative, name, namespace=None):
            tree = ast.parse((destination / relative).read_text(encoding="utf-8"))
            node = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
            module = ast.Module(body=[node], type_ignores=[])
            scope = namespace or {}
            exec(compile(module, relative, "exec", flags=__future__.annotations.compiler_flag), scope)
            return scope[name]

        persist = []
        restore = function("agent/conversation_loop.py", "_restore_or_build_system_prompt", {"_persist_system_prompt": lambda *a, **kw: persist.append(kw)})
        self.agent._cached_system_prompt = "OLD_CACHED_PROMPT"
        restore(self.agent, None, [{"role": "user", "content": "earlier"}])
        self.assertIn("CORE_INITIAL", self.agent._cached_system_prompt)
        self.assertEqual(persist, [{"persist_tools": True}])
        for name in ("_spawn_background_review", "_spawn_background_review_now", "shutdown_memory_provider", "commit_memory_session", "_sync_external_memory_for_turn"):
            method = function("run_agent.py", name)
            if name.startswith("_spawn"):
                method(self.agent, [{"role": "user", "content": "SESSION_ONLY_CANARY"}])
            elif name == "_sync_external_memory_for_turn":
                method(self.agent, original_user_message="SESSION_ONLY_CANARY", final_response="done", interrupted=False)
            else:
                method(self.agent, messages=[{"role": "user", "content": "SESSION_ONLY_CANARY"}])
        self.assertIsNone(function("agent/agent_init.py", "_select_context_engine")({"context": {"engine": "unqualified"}}))
        for name, kwargs in (("_collect_pre_llm_call_context", dict(effective_task_id="x", turn_id="x", original_user_message="Q", messages=[], conversation_history=[])),
                             ("_memory_turn_start_and_prefetch", dict(original_user_message="Q", turn_author=None))):
            self.assertEqual(function("agent/turn_context.py", name)(self.agent, **kwargs), "")
        self.room = types.SimpleNamespace(target_profile="writer")
        self.agent.session_id = "group-hook"
        group = function("agent/turn_context.py", "build_api_messages")
        rows, _ = group(self.agent, [{"role": "user", "content": "PUBLIC", "api_content": "PRIVATE"}], current_turn_user_idx=0,
                        ext_prefetch_cache="PRIVATE", plugin_user_context="PRIVATE", moa_config=None, active_system_prompt="PRIVATE")
        self.assertNotIn("PRIVATE", json.dumps(rows))
        self.assertEqual(function("agent/chat_completion_helpers.py", "_iteration_summary_api_messages")(self.agent, [{"role": "user", "content": "PUBLIC"}])[1]["content"], "PUBLIC")
        block = function("agent/agent_runtime_helpers.py", "_pre_tool_block_message")(self.agent, "terminal", {}, "task", "call", [])
        self.assertIn("public-workspace", block[0])
        self.assertIsNone(function("agent/agent_init.py", "_init_memory")(self.agent, {}, False, "api"))
        self.assertIsNone(self.agent._memory_store)

    @unittest.skipUnless(os.environ.get("HOB_QUALIFIED_RUNTIME"), "Exact pinned source checkout not supplied")
    def test_native_compaction_owners_preserve_archive_and_refuse_overflow_rotation(self):
        source_root = Path(os.environ["HOB_QUALIFIED_RUNTIME"])
        revised = compat.revisions({name: (source_root / name).read_text(encoding="utf-8") for name in compat.SOURCES})

        def function(relative, name, namespace=None):
            tree = ast.parse(revised[relative])
            node = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
            scope = namespace or {}
            exec(compile(ast.Module(body=[node], type_ignores=[]), relative, "exec", flags=__future__.annotations.compiler_flag), scope)
            return scope[name]

        # The actual native function bodies must return before invoking native
        # compressors, leases, summary providers, pruning or archive writes.
        messages = self.history(25)
        original = copy.deepcopy(messages)
        outcome = lambda **kwargs: types.SimpleNamespace(**kwargs)
        start = function("agent/turn_context_compaction.py", "run_turn_start_compaction", {"CompactionOutcome": outcome})
        result = start(self.agent, messages=messages, system_message=None, active_system_prompt="system", conversation_history=messages,
                       current_turn_user_idx=97, user_message="latest", effective_task_id="task")
        self.assertIs(result.messages, messages)
        self.assertIs(result.conversation_history, messages)
        self.assertEqual(result.current_turn_user_idx, 97)
        gate = function("agent/turn_preflight.py", "run_preflight_compression")
        verdict = types.SimpleNamespace(action="continue", result="stale", _provider_overflow_recovery_pending=False)
        kwargs = dict(compressor=object(), request_pressure_tokens=999999, provider_overflow_preflight=False, defer_preflight=None,
                      moa_prepared_request=None, system_message=None, user_message="latest", max_compression_attempts=3, effective_task_id="task")
        self.assertIs(gate(self.agent, verdict, **kwargs), verdict)
        self.assertEqual((verdict.action, verdict.result), ("fallthrough", None))
        for provider_overflow, pending in ((True, False), (False, True)):
            verdict._provider_overflow_recovery_pending = pending
            with self.assertRaisesRegex(team.TeamContextError, "provider rejected"):
                gate(self.agent, verdict, **(kwargs | {"provider_overflow_preflight": provider_overflow}))
        post = function("agent/turn_preflight.py", "compress_after_tool_results", {"PostToolCompressionVerdict": outcome})
        result = post(self.agent, messages=messages, system_message=None, user_message="latest", active_system_prompt="system",
                      conversation_history=messages, compression_attempts=0, max_compression_attempts=3, effective_task_id="task",
                      final_response="done", turn_exit_reason="completed", current_turn_user_idx=97)
        self.assertIs(result.messages, messages)
        self.assertFalse(result.end_turn)
        function("agent/turn_finalizer.py", "_micro_compact_after_turn")(self.agent, messages, "done", None, "task")
        log = unittest.mock.Mock()
        with patch.object(team, "enabled", side_effect=team.TeamContextError("authority disappeared")):
            function("agent/turn_finalizer.py", "_micro_compact_after_turn")(self.agent, messages, "done", log, "task")
        log.warning.assert_called_once_with("Team authority unavailable; skipped archive micro-compaction.")
        compress = function("agent/conversation_compression.py", "compress_context")
        for options in ({}, {"force": True}, {"trigger": "gateway_hygiene"}, {"trigger": "overflow", "bypass_cooldown": True}):
            with self.assertRaisesRegex(team.TeamContextError, "archive compression and rotation"):
                compress(self.agent, messages, "system", **options)
        recover = function("agent/conversation_compression.py", "recover_rotated_compression_session", {"_session_was_rotated_by_compression": lambda *args: True})
        self.assertIsNone(recover(self.agent))
        self.agent._session_db = object()
        with self.assertRaisesRegex(team.TeamContextError, "rotated outside team context"):
            recover(self.agent)
        self.assertEqual(messages, original)
        self.assertEqual(self.agent.session_id, "user-1")

        # Execute the complete patched native request assembler with explicit
        # transport/sanitizer seams. A late prefill must fail at its final guard,
        # even though the original projected history fits comfortably.
        def module(name, **values):
            result = types.ModuleType(name)
            result.__dict__.update(values)
            return result

        noop = lambda *args, **kwargs: None
        identity = lambda agent, rows, *args, **kwargs: rows
        native_modules = {
            "agent.conversation_loop": module("agent.conversation_loop", _CODEX_INCOMPLETE_NUDGE="nudge",
                _apply_context_engine_selection=identity, _canonicalize_api_tool_calls=noop,
                _clone_message_for_send=copy.deepcopy, _midturn_request_pressure_tokens=lambda a, m, s, t: t,
                _pressure_with_real_floor=lambda compressor, value: value),
            "agent.anthropic_thinking_replay": module("agent.anthropic_thinking_replay", apply_rejected_thinking_suppression=noop),
            "agent.context_compressor": module("agent.context_compressor", evict_stale_outbound_tool_images=noop),
            "agent.image_eviction_policy": module("agent.image_eviction_policy", outbound_retired_image_ids=lambda agent: set()),
            "agent.agent_runtime_helpers": module("agent.agent_runtime_helpers", consume_pending_sanitizer_heal_notice=lambda: None),
            "agent.turn_context": module("agent.turn_context", _agent_stale_thinking_on_wire=lambda agent: False),
        }
        metadata = sys.modules["agent.model_metadata"]
        metadata.estimate_messages_tokens_rough = lambda rows, **kwargs: metadata.estimate_request_tokens_rough(rows)
        metadata.estimate_native_anthropic_messages_tokens_rough = metadata.estimate_messages_tokens_rough
        assembly = function("agent/turn_request_assembly.py", "assemble_api_request", {
            "build_api_messages": lambda agent, rows, **kwargs: (team.bound_messages(agent, rows), "Required system context"),
            "_sanitize_messages_surrogates": noop, "anchored_context_tokens": lambda *args: None,
            "AssembledRequest": lambda *args: types.SimpleNamespace(messages=args[1]),
        })
        self.agent.prefill_messages = []
        self.agent.api_mode = "chat_completions"
        self.agent.provider = "fixture"
        self.agent._use_prompt_caching = False
        self.agent._sanitize_api_messages = lambda rows: rows
        self.agent._drop_thinking_only_and_merge_users = lambda rows, **kwargs: rows
        assembly_kwargs = dict(messages=messages, current_turn_user_idx=97, _ext_prefetch_cache="", _plugin_user_context="",
                               moa_config=None, active_system_prompt="Required system context", original_user_message="latest",
                               pending_moa_prepared_request=None, request_logger=None)
        with patch.dict(sys.modules, native_modules):
            result = assembly(self.agent, **assembly_kwargs)
            self.assertEqual(sum(row["role"] == "user" for row in result.messages), 20)
            self.agent.prefill_messages = [{"role": "assistant", "content": "LATE_PREFILL_" * 10000}]
            with self.assertRaisesRegex(team.TeamContextError, "middleware and tools"):
                assembly(self.agent, **assembly_kwargs)
        self.assertEqual(messages, original)

        # Prove ordinary mode reaches the original native implementation rather
        # than accidentally applying a team-only shortcut.
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),))
        self.db.commit()
        self.agent._hob_team_enabled = False
        legacy = unittest.mock.Mock(side_effect=RuntimeError("legacy compressor reached"))
        native = function("agent/conversation_compression.py", "compress_context", {"_begin_compression_attempt": legacy})
        with self.assertRaisesRegex(RuntimeError, "legacy compressor reached"):
            native(self.agent, messages, "system")
        legacy.assert_called_once()


if __name__ == "__main__":
    unittest.main()

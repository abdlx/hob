"""Execute patched native memory/skill owners using only disposable state.

The overlay contains checksum-qualified patched modules. All other imports use
the exact pinned runtime. Networking is forbidden throughout this probe.
"""
import atexit
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


native = Path(os.environ["HOB_QUALIFIED_RUNTIME"]).resolve()
temporary = tempfile.TemporaryDirectory(prefix="hob-pinned-private-retention-")
atexit.register(temporary.cleanup)
root = Path(temporary.name)
overlay = root / "runtime"
os.environ["HERMES_HOME"] = str(root / "initial-home")
Path(os.environ["HERMES_HOME"]).mkdir()
spec = importlib.util.spec_from_file_location("team_compat", Path(__file__).with_name("apply-hermes-team-compat.py"))
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)
for relative in compat.SOURCES:
    target = overlay / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes((native / relative).read_bytes())
compat.install(overlay)
for package in ("agent", "tools", "hermes_cli"):
    target = overlay / package / "__init__.py"
    target.write_text("__path__.append(" + repr(str(native / package)) + ")\n" + (native / package / "__init__.py").read_text(encoding="utf-8"), encoding="utf-8")
sys.path[:0] = [str(overlay), str(native)]
network_attempts = []
def no_network(*args, **kwargs):
    network_attempts.append(True)
    raise AssertionError("Networking is forbidden in the native retention probe")
socket.socket.connect = no_network

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent import hob_team_context as context, hob_team_retention as retention
from agent.inline_tool_executors import emit_terminal_post_tool_call
from tools import memory_tool, skill_manager_tool, write_approval
from tools.skills_tool import skills_list
from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
from tools.daemon_pool import DaemonThreadPoolExecutor
from agent.skill_utils import get_all_skills_dirs, get_project_skills_dirs

controls_spec = importlib.util.spec_from_file_location("hob_native_reviews", Path(__file__).with_name("hob-native-controls.py"))
controls = importlib.util.module_from_spec(controls_spec)
controls_spec.loader.exec_module(controls)


class NativeRetentionTests(unittest.TestCase):
    def setUp(self):
        self.case = tempfile.TemporaryDirectory(prefix="case-", dir=root)
        self.addCleanup(self.case.cleanup)
        self.base = Path(self.case.name)
        self.home = self.base / "native" / "profiles" / "writer"
        self.other = self.base / "native" / "profiles" / "editor"
        self.workspace = self.base / "workspaces" / "writer"
        self.workspace.mkdir(parents=True)
        for home in (self.home, self.other):
            (home / "memories").mkdir(parents=True)
            (home / "skills" / "retained-lesson").mkdir(parents=True)
            (home / "memories" / "MEMORY.md").write_text("Existing durable private note.", encoding="utf-8")
            (home / "memories" / "USER.md").write_text("", encoding="utf-8")
            (home / "config.yaml").write_text("memory:\n  memory_enabled: true\n  user_profile_enabled: true\n  write_approval: false\nskills:\n  write_approval: false\n", encoding="utf-8")
        self.lesson = "Verify the produced output before reporting completion."
        (self.home / "skills" / "retained-lesson" / "SKILL.md").write_text(self.skill("retained-lesson", self.lesson), encoding="utf-8")
        (self.other / "skills" / "retained-lesson" / "SKILL.md").write_text(self.skill("retained-lesson", "OTHER_BOT_PRIVATE_SKILL_CANARY"), encoding="utf-8")
        self.db = sqlite3.connect(self.base / "employee-team.sqlite")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_profiles(profile TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_sessions(profile TEXT,session TEXT,kind TEXT,assignment TEXT);
            CREATE TABLE core_versions(revision INTEGER,content TEXT,digest TEXT);
        """)
        self.policy = {"nativeContext": True, "paidExecution": False, "allowSubscriptions": True, "sessionWindow": 20, "coreBudget": 4000}
        self.db.execute("INSERT INTO settings VALUES(1,?)", (json.dumps(self.policy),))
        for profile, home in (("writer", self.home), ("editor", self.other)):
            self.db.execute("INSERT INTO runtime_profiles VALUES(?,?)", (profile, json.dumps({"name": profile, "role": "", "roster": [], "home": str(home), "workspace": str(self.workspace)})))
            self.db.execute("INSERT INTO runtime_sessions VALUES(?,?,'user','')", (profile, profile + "-chat"))
        self.db.commit()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HERMES_HOB_TEAM_STATE_DB": str(self.base / "employee-team.sqlite")}).start()
        token = set_hermes_home_override(self.home)
        self.addCleanup(reset_hermes_home_override, token)
        origin = set_current_write_origin("foreground")
        self.addCleanup(reset_current_write_origin, origin)
        retention._turn.set(None)
        self.agent = types.SimpleNamespace(session_id="writer-chat", api_mode="chat_completions")
        context.turn_start(self.agent)
        self.store = memory_tool.MemoryStore()
        self.store.load_from_disk()

    @staticmethod
    def skill(name, content):
        return f"---\nname: {name}\ndescription: A private deterministic procedure.\n---\n\n# Procedure\n\n{content}\n"

    def memory(self, **values):
        return json.loads(memory_tool.memory_tool(store=self.store, **values))

    def record(self, result, subsystem="memory"):
        self.assertTrue(result["staged"])
        record = write_approval.get_pending(subsystem, result["pending_id"])
        self.assertEqual(record["team"]["profile"], "writer")
        self.assertEqual(record["team"]["session"], "writer-chat")
        return record

    def approve(self, record, subsystem="memory", **extra):
        body = {"id": record["id"], "revision": controls.revision(record), "action": "approve", "requestId": "review-" + record["id"], "confirm": True, **extra}
        return controls.decide(subsystem, body, "writer")

    def test_chat_fact_stays_out_of_memory_and_a_new_session_without_promotion(self):
        before = {path.name: path.read_bytes() for path in (self.home / "memories").iterdir()}
        result = self.memory(action="add", target="memory", content="SESSION_ONLY_MANGO_7_CANARY")
        record = self.record(result)
        self.assertEqual(before, {path.name: path.read_bytes() for path in (self.home / "memories").iterdir() if path.suffix == ".md"})
        self.assertEqual(record["payload"]["content"], "SESSION_ONLY_MANGO_7_CANARY")
        with self.assertRaises(Exception) as denied:
            self.approve(record)
        self.assertEqual(denied.exception.status_code, 400)
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','new-chat','user','')"); self.db.commit()
        context.turn_start(types.SimpleNamespace(session_id="new-chat", api_mode="chat_completions"))
        fresh = memory_tool.MemoryStore(); fresh.load_from_disk()
        self.assertNotIn("MANGO", fresh.format_for_system_prompt("memory") or "")
        token = set_hermes_home_override(self.other)
        try:
            other = memory_tool.MemoryStore(); other.load_from_disk()
            self.assertNotIn("MANGO", other.format_for_system_prompt("memory") or "")
        finally:
            reset_hermes_home_override(token)

    def test_native_archive_resume_rebuilds_only_its_own_session_summary(self):
        from hermes_state import SessionDB
        database = self.home / "state.db"
        writer = SessionDB(db_path=database)
        try:
            writer.create_session("writer-chat", "cli")
            writer.create_session("fresh-chat", "cli")
            for index in range(24):
                prompt = "Decision: SESSION_ONLY_MANGO_7 must stay in this chat." if index == 0 else f"Question {index}"
                reply = "Decision: use CSV.\nFILES: artifacts/report.csv\nNext: inspect the totals." if index == 0 else f"Answer {index}"
                call_id = f"read-{index}"
                writer.append_message("writer-chat", "user", prompt)
                writer.append_message("writer-chat", "assistant", None, tool_calls=[{"id": call_id, "type": "function", "function": {"name": "read_file", "arguments": '{"path":"inputs/source.csv"}'}}])
                writer.append_message("writer-chat", "tool", '{"exit_code":0,"output":"Fixture file contents"}', tool_call_id=call_id, tool_name="read_file")
                writer.append_message("writer-chat", "assistant", reply)
            writer.append_message("fresh-chat", "user", "An independent conversation.")
        finally:
            writer.close()
        before = database.read_bytes()
        def restored(session):
            reader = SessionDB(db_path=database, read_only=True)
            try:
                model, display = reader.get_resume_conversations(session)
                return model, display
            finally:
                reader.close()
        messages, display = restored("writer-chat")
        original = json.dumps(messages, ensure_ascii=False)
        agent = types.SimpleNamespace(session_id="writer-chat", api_mode="chat_completions", tools=[], context_compressor=types.SimpleNamespace(context_length=32000))
        context.turn_start(agent)
        projected = context.bound_messages(agent, messages)
        self.assertEqual(sum(row["role"] == "user" for row in projected), 20)
        self.assertIn("SESSION_ONLY_MANGO_7", projected[0]["content"])
        self.assertIn("Reported decisions", projected[0]["content"])
        self.assertIn("File references", projected[0]["content"])
        self.assertIn("Open items", projected[0]["content"])
        context._validate_tools(projected)
        self.assertEqual(json.dumps(messages, ensure_ascii=False), original)
        # A fresh DB/agent instance reconstructs the same projection, with no
        # serialized summary cache and no writes to the native conversation.
        restarted_messages, restarted_display = restored("writer-chat")
        self.assertEqual(display, restarted_display)
        self.assertEqual(projected, context.bound_messages(agent, restarted_messages))
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','fresh-chat','user','')"); self.db.commit()
        agent.session_id = "fresh-chat"
        context.turn_start(agent)
        fresh, _ = restored("fresh-chat")
        self.assertNotIn("MANGO", json.dumps(context.bound_messages(agent, fresh)))
        self.assertNotIn("MANGO", (self.home / "memories" / "MEMORY.md").read_text())
        self.assertNotIn("MANGO", (self.other / "memories" / "MEMORY.md").read_text())
        self.assertEqual(database.read_bytes(), before)

    def test_eligible_task_observation_and_retained_skill_excerpt_write_without_extra_approval(self):
        emit_terminal_post_tool_call(self.agent, function_name="terminal", function_args={"command": "unused"},
                                    result={"output": "SESSION_ONLY_MANGO_7_CANARY"}, effective_task_id="task", tool_call_id="call", status="success")
        observation = next(iter(retention._turn.get()["observations"]))
        result = self.memory(action="add", target="memory", content=observation)
        self.assertTrue(result["success"]); self.assertNotIn("staged", result)
        result = self.memory(action="add", target="memory", content=self.lesson)
        self.assertTrue(result["success"]); self.assertNotIn("staged", result)
        text = (self.home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
        self.assertIn(observation, text); self.assertIn(self.lesson, text); self.assertNotIn("MANGO", text)
        self.assertFalse(write_approval.list_pending("memory"))
        self.assertIn("write_approval: false", (self.home / "config.yaml").read_text())

    def test_task_observations_cannot_follow_another_session_or_group_projection(self):
        retention.observe_tool(self.agent, "terminal", "success")
        self.assertIn("Verified own task observations", retention.learning_evidence(self.agent))
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','another-chat','user','')"); self.db.commit()
        another = types.SimpleNamespace(session_id="another-chat", api_mode="chat_completions", tools=[], context_compressor=types.SimpleNamespace(context_length=32000))
        # Deliberately retain the old ContextVar, as a stale renderer callback
        # might. The request's trusted agent/session still controls disclosure.
        self.assertEqual(retention.learning_evidence(another), "")
        self.assertNotIn("Verified own task observations", json.dumps(context.bound_messages(another, [{"role": "user", "content": "Fresh question."}])))
        room_agent = types.SimpleNamespace(session_id="unbound-room", api_mode="chat_completions", tools=[], context_compressor=types.SimpleNamespace(context_length=32000))
        with patch.object(context, "_room", return_value=types.SimpleNamespace(target_profile="writer")):
            self.assertEqual(retention.learning_evidence(room_agent), "")
            self.assertNotIn("Verified own task observations", json.dumps(context.bound_messages(room_agent, [{"role": "user", "content": "Public room question."}])))

    def test_confirmed_private_promotion_applies_once_to_its_own_profile(self):
        record = self.record(self.memory(action="add", target="memory", content="An explicitly retained private interaction note."))
        result = self.approve(record, confirmPrivatePromotion=True)
        self.assertTrue(result["ok"])
        self.assertTrue(result["decision"]["privatePromotionConfirmed"])
        self.assertTrue(self.approve(record, confirmPrivatePromotion=True)["replayed"])
        self.assertNotIn("retained private interaction", (self.other / "memories" / "MEMORY.md").read_text())
        self.assertIn("retained private interaction", (self.home / "memories" / "MEMORY.md").read_text())

    def test_skills_remain_staged_and_refuse_a_changed_reviewed_source(self):
        content = self.skill("new-lesson", "Check the final local output before completing the task.")
        result = json.loads(skill_manager_tool.skill_manage(action="create", name="new-lesson", content=content))
        record = self.record(result, "skills")
        self.assertFalse((self.home / "skills" / "new-lesson").exists())
        self.assertIn("Check the final local output", record["stagedDiff"])
        self.approve(record, "skills", confirmPrivatePromotion=True)
        self.assertTrue((self.home / "skills" / "new-lesson" / "SKILL.md").is_file())
        result = json.loads(skill_manager_tool.skill_manage(action="patch", name="new-lesson", old_string="final local output", new_string="final verified output"))
        record = self.record(result, "skills")
        path = self.home / "skills" / "new-lesson" / "SKILL.md"
        path.write_text(path.read_text() + "\nA later user edit.\n", encoding="utf-8")
        with self.assertRaises(Exception) as denied:
            self.approve(record, "skills", confirmPrivatePromotion=True)
        self.assertEqual(denied.exception.status_code, 409)
        self.assertIn("A later user edit", path.read_text()); self.assertNotIn("final verified output", path.read_text())

    def test_background_unbound_revoked_and_finished_turns_cannot_stage(self):
        origin = set_current_write_origin("background_review")
        try:
            with self.assertRaises(context.TeamContextError):
                self.memory(action="add", target="memory", content="background private fact")
        finally:
            reset_current_write_origin(origin)
        retention._turn.set(None)
        with self.assertRaises(context.TeamContextError):
            self.memory(action="add", target="memory", content="unbound private fact")
        captured = []
        @retention.turn_scope
        def run():
            context.turn_start(self.agent); captured.append(retention._turn.get())
        run()
        self.assertIsNone(retention._turn.get()); self.assertFalse(captured[0]["active"])
        context.turn_start(self.agent)
        self.db.execute("DELETE FROM runtime_profiles WHERE profile='writer'"); self.db.commit()
        with self.assertRaises(context.TeamContextError):
            self.memory(action="add", target="memory", content="revoked private fact")
        self.assertFalse(write_approval.list_pending("memory"))

    def test_reused_native_worker_thread_keeps_each_profile_private(self):
        def work(profile, home):
            token = set_hermes_home_override(home)
            try:
                context.turn_start(types.SimpleNamespace(session_id=profile + "-chat", api_mode="chat_completions"))
                return retention.private_skill_root(), retention._turn.get()["profile"]
            finally:
                reset_hermes_home_override(token)
        with DaemonThreadPoolExecutor(max_workers=1) as pool:
            one = pool.submit(work, "writer", self.home).result(timeout=5)
            two = pool.submit(work, "editor", self.other).result(timeout=5)
        self.assertEqual(one, (self.home / "skills", "writer")); self.assertEqual(two, (self.other / "skills", "editor"))

    def test_external_and_project_skill_sources_do_not_leak_after_team_activation(self):
        other_skill = self.other / "skills" / "other-private"
        other_skill.mkdir()
        (other_skill / "SKILL.md").write_text(self.skill("other-private", "OTHER_BOT_PRIVATE_SKILL_CANARY"), encoding="utf-8")
        config = self.home / "config.yaml"
        config.write_text(config.read_text() + "  external_dirs:\n    - " + json.dumps(str(self.other / "skills")) + "\n  create_dir: " + json.dumps(str(self.other / "skills")) + "\n", encoding="utf-8")
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),)); self.db.commit()
        retention._turn.set(None)
        self.assertIn(self.other / "skills", get_all_skills_dirs())
        self.assertIn("other-private", skills_list())
        self.policy["nativeContext"] = True
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),)); self.db.commit()
        context.turn_start(self.agent)
        self.assertEqual(get_all_skills_dirs(), [self.home / "skills"])
        self.assertEqual(get_project_skills_dirs(), [])
        self.assertNotIn("other-private", skills_list())
        self.assertEqual(skill_manager_tool._find_skill_in_other_profiles("other-private"), [])
        self.assertEqual(skill_manager_tool._resolve_skill_dir("new-lesson"), self.home / "skills" / "new-lesson")

    def test_configured_approval_is_preserved_and_unproven_receipts_do_not_grant_permission(self):
        with patch.object(write_approval, "write_approval_enabled", return_value=True), patch.object(write_approval, "_prompt_inline_memory_approval", return_value=None) as prompt:
            result = self.memory(action="add", target="memory", content=self.lesson)
            self.record(result)
            prompt.assert_called_once()
        result = self.memory(action="add", target="memory", content="Tool observation at 2000-01-01T00:00:00Z: terminal completed.")
        self.record(result)
        self.assertNotIn("2000-01-01", (self.home / "memories" / "MEMORY.md").read_text())

    def test_staging_failure_and_credentials_never_become_false_success(self):
        with patch.object(retention, "_publish", side_effect=OSError("fixture storage failure")):
            with self.assertRaises(OSError):
                self.memory(action="add", target="memory", content="Unproven private note during storage failure.")
        self.assertFalse(write_approval.list_pending("memory"))
        with self.assertRaises(context.TeamContextError):
            self.memory(action="add", target="memory", content="api_key=synthetic-secret-credential-value")
        self.assertFalse(write_approval.list_pending("memory"))
        self.assertFalse(retention._sensitive('api_key=os.environ["OPENAI_API_KEY"]'))
        self.assertTrue(retention._sensitive('"api_key": "synthetic-secret-credential-value"'))

    def test_group_context_and_disabled_authority_cannot_retain_private_notes(self):
        self.db.execute("UPDATE runtime_sessions SET kind='group' WHERE profile='writer'")
        self.db.commit()
        with self.assertRaises(context.TeamContextError):
            self.memory(action="add", target="memory", content="A group conversation fact.")
        self.db.execute("UPDATE runtime_sessions SET kind='user' WHERE profile='writer'")
        self.db.commit()
        context.turn_start(self.agent)
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),)); self.db.commit()
        with self.assertRaises(context.TeamContextError):
            self.memory(action="add", target="memory", content="A write after authority was disabled.")
        self.assertFalse(write_approval.list_pending("memory"))

    @unittest.skipIf(os.name == "nt", "Production directory descriptors and symlinks require Linux")
    def test_linked_roots_and_directory_substitution_cannot_publish(self):
        pending = self.home / "pending"
        pending.symlink_to(self.other, target_is_directory=True)
        try:
            with self.assertRaises(OSError):
                self.memory(action="add", target="memory", content="A linked pending directory must refuse this note.")
        finally:
            pending.unlink()
        self.assertFalse((self.other / "memory").exists())
        original = retention._publish
        def substitute(fd, directory, temporary, final):
            target = pending / "memory"
            target.rename(pending / "detached-memory")
            target.mkdir()
            original(fd, directory, temporary, final)
        with patch.object(retention, "_publish", side_effect=substitute):
            with self.assertRaises(context.TeamContextError):
                self.memory(action="add", target="memory", content="A replaced pending directory must not report staging success.")
        self.assertFalse(write_approval.list_pending("memory"))

    def test_hardlinked_skill_source_cannot_authorize_an_autonomous_memory_write(self):
        path = self.home / "skills" / "retained-lesson" / "SKILL.md"
        os.link(path, self.base / "linked-skill-copy")
        self.record(self.memory(action="add", target="memory", content=self.lesson))
        self.assertNotIn(self.lesson, (self.home / "memories" / "MEMORY.md").read_text())

    def isolation_contract(self):
        from agent import hob_team_isolation as guard
        from tools.environments.ssh import SSHEnvironment
        binding = {"version": 1, "profile": "writer", "uid": 20001, "gid": 20001, "user": "hob20001",
                   "workspace": str(self.workspace), "host": "127.0.0.1", "port": 22220,
                   "keyPath": str(self.base / "isolation-keys" / "writer.key")}
        patch.object(guard, "_platform_supported", return_value=True).start()
        patch.object(guard, "_broker", return_value=binding).start()
        config = {"env_type": "ssh", "ssh_host": binding["host"], "ssh_user": binding["user"], "ssh_port": binding["port"], "ssh_key": binding["keyPath"]}
        # Real native class, no constructor/network: this is an explicit owner
        # contract seam. The Linux image probe exercises actual SSH bring-up.
        env = SSHEnvironment.__new__(SSHEnvironment)
        env.host, env.user, env.port, env.key_path = binding["host"], binding["user"], binding["port"], binding["keyPath"]
        return guard, config, env

    def test_isolation_factory_refuses_local_and_another_principal_before_creation(self):
        guard, config, env = self.isolation_contract()
        calls = []
        create = guard.factory(lambda *args, **kwargs: calls.append(True) or env)
        for change in ({"env_type": "local"}, {"ssh_user": "hob20002"}, {"ssh_key": "other-profile.key"}, {"ssh_host": "remote.invalid"}):
            invalid = {**config, **change}
            with self.assertRaises(context.TeamContextError):
                create(invalid, invalid["env_type"])
        self.assertFalse(calls)
        self.assertIs(create(config, "ssh"), env)
        self.assertEqual(calls, [True])

    def test_isolation_cached_environment_cannot_change_principal_or_use_a_legacy_cache(self):
        guard, config, env = self.isolation_contract()
        plan = types.SimpleNamespace(config=config, env_type="ssh")
        get = guard.acquire(lambda *args: env)
        with self.assertRaises(context.TeamContextError):
            get(plan, "shared-task")
        guard.factory(lambda *args, **kwargs: env)(config, "ssh")
        self.assertIs(get(plan, "shared-task"), env)
        env.user = "hob20002"
        with self.assertRaises(context.TeamContextError):
            get(plan, "shared-task")

    def test_isolation_revocation_and_missing_scope_stop_cached_execution(self):
        guard, config, env = self.isolation_contract()
        guard.factory(lambda *args, **kwargs: env)(config, "ssh")
        calls = []
        get = guard.acquire(lambda *args: calls.append(True) or env)
        with patch.object(guard, "_broker", side_effect=context.TeamContextError("fixture revoked")):
            with self.assertRaises(context.TeamContextError):
                get(types.SimpleNamespace(config=config, env_type="ssh"), "shared-task")
        self.assertFalse(calls)
        retention._turn.set(None)
        with self.assertRaises(context.TeamContextError):
            get(types.SimpleNamespace(config=config, env_type="ssh"), "unbound-task")

    def test_isolation_wrappers_leave_ordinary_mode_execution_unchanged(self):
        from agent import hob_team_isolation as guard
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),)); self.db.commit()
        retention._turn.set(None)
        local = object()
        with patch.object(guard, "_broker", side_effect=AssertionError("Ordinary mode queried broker")):
            self.assertIs(guard.factory(lambda *args, **kwargs: local)({"env_type": "local"}, "local"), local)
            self.assertIs(guard.acquire(lambda *args: local)(types.SimpleNamespace(config={}, env_type="local"), "task"), local)

    def tearDown(self):
        self.assertEqual(network_attempts, [])


if __name__ == "__main__":
    unittest.main()

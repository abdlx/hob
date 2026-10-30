"""Exercise version binding and uncertain decisions without starting a model or runtime."""
import importlib.util
import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path


class Refusal(Exception):
    def __init__(self, status, detail):
        self.status_code = status
        super().__init__(detail)


class Router:
    def get(self, _path):
        return lambda fn: fn
    post = get


sys.modules["fastapi"] = types.SimpleNamespace(APIRouter=Router, HTTPException=Refusal)
spec = importlib.util.spec_from_file_location("controls", Path(__file__).with_name("hob-native-controls.py"))
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


class NativeReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hob-native-review-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.applied = []
        self.native = types.SimpleNamespace(_pending_path=lambda subsystem, pending_id: self.home / "pending" / subsystem / f"{pending_id}.json")
        sys.modules["tools"] = types.SimpleNamespace(write_approval=self.native)
        sys.modules["tools.memory_tool"] = types.SimpleNamespace(load_on_disk_store=lambda: "fresh-native-memory")
        sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
        sys.modules["hermes_cli.write_approval_commands"] = types.SimpleNamespace(_apply_one=self.apply)
        sys.modules["hermes_constants"] = types.SimpleNamespace(get_hermes_home=lambda: self.home)

    def apply(self, subsystem, record, store):
        self.applied.append((subsystem, record, store))
        return True, "", {"success": True}

    def seed(self, subsystem="memory"):
        record = {"id": "abc12345", "payload": {"action": "add", "content": "A reviewed fact"}, "summary": "Remember a fact"}
        filename = self.native._pending_path(subsystem, record["id"])
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(json.dumps(record), encoding="utf-8")
        body = {"id": record["id"], "revision": controls.revision(record), "action": "approve", "requestId": "a" * 32, "confirm": True}
        return record, filename, body

    def test_exact_revision_and_same_request_apply_once_and_persist_history(self):
        record, filename, body = self.seed()
        first = controls.decide("memory", body)
        replay = controls.decide("memory", body)
        self.assertTrue(first["ok"])
        self.assertTrue(replay["replayed"])
        self.assertFalse(filename.exists())
        self.assertEqual(self.applied, [("memory", record, "fresh-native-memory")])
        self.assertEqual(len(controls.audit_history()), 1)

    def test_stale_revision_and_unconfirmed_decision_never_apply(self):
        _record, filename, body = self.seed()
        for change in [{"revision": "0" * 64}, {"confirm": False}, {"id": "../other"}, {"id": "all"}]:
            with self.assertRaises(Refusal):
                controls.decide("memory", {**body, **change})
        self.assertTrue(filename.exists())
        self.assertFalse(self.applied)

    def test_failed_native_apply_preserves_a_claim_instead_of_enabling_replay(self):
        _record, filename, body = self.seed()
        sys.modules["hermes_cli.write_approval_commands"]._apply_one = lambda *args: (False, "stale native preimage", {})
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        self.assertFalse(filename.exists())
        self.assertEqual(len(list(filename.parent.glob(".hob-claimed-*.claim"))), 1)
        self.assertFalse(controls.audit_history())

    def test_partial_native_failure_is_reconciled_without_applying_or_undoing(self):
        record, filename, body = self.seed()
        def uncertain(subsystem, proposal, store):
            self.applied.append(proposal)
            return False, "synthetic acknowledgement lost after a side effect", {}
        sys.modules["hermes_cli.write_approval_commands"]._apply_one = uncertain
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        self.assertEqual(self.applied, [record])
        self.assertEqual(controls.get_claim("memory", body["id"], body["revision"]), record)
        observation = {**body, "action": "observed_applied", "requestId": "r" * 32}
        for change in [{"confirm": False}, {"revision": "0" * 64}, {"action": "approve"}, {"action": []}]:
            with self.assertRaises(Refusal):
                controls.reconcile_claim("memory", {**observation, **change})
        self.assertEqual(controls.reconcile_claim("memory", observation)["decision"]["status"], "operator_reconciled")
        self.assertTrue(controls.reconcile_claim("memory", observation)["replayed"])
        self.assertEqual(self.applied, [record])
        self.assertFalse(filename.exists())
        self.assertFalse(list(filename.parent.glob(".hob-claimed-*.claim")))

    def test_abandoning_an_uncertain_claim_never_calls_native_apply(self):
        _record, filename, body = self.seed()
        original = controls.append_audit
        controls.append_audit = lambda _record: (_ for _ in ()).throw(OSError("synthetic audit failure"))
        try:
            with self.assertRaises(OSError):
                controls.decide("memory", {**body, "action": "reject"})
        finally:
            controls.append_audit = original
        result = controls.reconcile_claim("memory", {**body, "action": "abandoned", "requestId": "r" * 32})
        self.assertTrue(result["ok"]); self.assertFalse(self.applied)
        self.assertFalse(filename.exists())

    def test_persisted_observation_recovers_an_interrupted_claim_removal(self):
        _record, filename, body = self.seed()
        sys.modules["hermes_cli.write_approval_commands"]._apply_one = lambda *args: (False, "unconfirmed", {})
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        observation = {**body, "action": "abandoned", "requestId": "r" * 32}
        with patch.object(Path, "unlink", side_effect=OSError("synthetic interruption after audit persistence")):
            with self.assertRaises(OSError):
                controls.reconcile_claim("memory", observation)
        self.assertEqual(len(controls.audit_history()), 1)
        self.assertEqual(len(list(filename.parent.glob(".hob-claimed-*.claim"))), 1)
        self.assertTrue(controls.reconcile_claim("memory", observation)["replayed"])
        self.assertEqual(len(controls.audit_history()), 1)
        self.assertFalse(list(filename.parent.glob(".hob-claimed-*.claim")))
        self.assertFalse(self.applied)

    def test_uncertain_post_apply_failure_is_not_blindly_replayed(self):
        _record, filename, body = self.seed()
        original = controls.append_audit
        controls.append_audit = lambda _record: (_ for _ in ()).throw(OSError("synthetic disk full"))
        try:
            with self.assertRaises(OSError):
                controls.decide("memory", body)
        finally:
            controls.append_audit = original
        self.assertFalse(filename.exists())
        self.assertEqual(len(list(filename.parent.glob(".hob-claimed-*.claim"))), 1)
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        self.assertEqual(len(self.applied), 1)

    def test_reject_never_calls_applier_and_request_ids_cannot_cross_subsystems(self):
        _record, _filename, body = self.seed()
        controls.decide("memory", {**body, "action": "reject"})
        self.assertFalse(self.applied)
        with self.assertRaises(Refusal):
            controls.decide("skills", {**body, "action": "reject"})

    def test_linked_proposals_are_refused(self):
        _record, filename, _body = self.seed()
        os.link(filename, filename.with_name("other.json"))
        with self.assertRaises(Refusal):
            controls.get_record("memory", "abc12345")

    def test_native_pending_paths_cannot_redirect_outside_the_profile(self):
        self.native._pending_path = lambda subsystem, pending_id: self.home.parent / "another-profile" / "pending" / subsystem / f"{pending_id}.json"
        with self.assertRaises(Refusal):
            controls.pending_path("memory", "abc12345")

    def test_structured_decision_fields_are_rejected_before_native_application(self):
        _record, _filename, body = self.seed()
        for change in [{"action": []}, {"revision": {}}, {"requestId": 42}]:
            with self.assertRaises(Refusal):
                controls.decide("memory", {**body, **change})
        self.assertFalse(self.applied)


class NativeActivityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="hob-native-activity-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.jobs = self.home / "cron" / "jobs.json"
        self.jobs.parent.mkdir()
        self.jobs.write_text(json.dumps({"jobs": [{"id": "paused-job", "enabled": False}]}), encoding="utf-8")
        self.rows = [{"id": "run-1", "source": "cron", "title": "Historical failed reminder", "started_at": 100, "ended_at": 200}]
        self.identity = {"cron_job_id": "deleted-job", "cron_execution_id": "fire-1"}
        self.lifecycle = "error"
        self.closed = False
        owner = self
        class Database:
            db_path = owner.home / "state.db"
            def list_sessions_rich(self, **kwargs):
                owner.assertEqual(kwargs, {"sources": ["cron"], "limit": 100, "offset": 0, "order_by_last_active": True, "compact_rows": True})
                return owner.rows
            def session_lifecycle_statuses(self, ids):
                return {key: owner.lifecycle for key in ids}
            def cron_run_identity(self, _sid):
                if isinstance(owner.identity, Exception):
                    raise owner.identity
                return owner.identity
            def close(self):
                owner.closed = True
        self.database = Database()
        def open_db(profile, *, read_only):
            self.assertEqual(profile, "writer")
            self.assertTrue(read_only)
            return self.database
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {
            "hermes_constants": types.SimpleNamespace(get_hermes_home=lambda: self.home),
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.web_server_sessions": types.SimpleNamespace(_open_session_db_for_profile=open_db),
            "cron": types.ModuleType("cron"),
            "cron.jobs": types.SimpleNamespace(_current_cron_store=lambda: types.SimpleNamespace(jobs_file=self.jobs)),
        }).start()

    def snapshot(self):
        result = controls.scheduled_activity_snapshot("writer")
        self.assertTrue(self.closed)
        self.assertIsNone(result["nextOffset"])
        return result["items"][0]

    def test_verified_deletion_preserves_failed_history_and_paused_jobs_are_present(self):
        original = self.jobs.read_bytes()
        item = self.snapshot()
        self.assertEqual(item["status"], "failed")
        self.assertEqual(item["origin"]["jobState"], "deleted")
        self.assertEqual(item["origin"]["profile"], "writer")
        self.assertEqual(item["origin"]["executionId"], "fire-1")
        self.assertTrue(item["origin"]["historical"])
        self.assertEqual(self.jobs.read_bytes(), original)
        self.identity["cron_job_id"] = "paused-job"
        self.assertEqual(self.snapshot()["origin"]["jobState"], "present")

    def test_inventory_outage_corruption_and_legacy_unlinked_are_distinct(self):
        self.jobs.write_bytes(b'{"jobs": broken json')
        before = self.jobs.read_bytes()
        item = self.snapshot()
        self.assertEqual(item["origin"]["jobState"], "unavailable")
        self.assertEqual(item["status"], "failed")
        self.assertEqual(self.jobs.read_bytes(), before)  # no native auto-repair
        self.identity = None
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unlinked")
        self.identity = {"cron_job_id": "unknown", "cron_execution_id": None}
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unlinked")
        self.identity = RuntimeError("private native error")
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unavailable")
        self.assertNotIn("private native error", json.dumps(self.snapshot()))

    def test_absent_file_is_empty_only_inside_the_verified_owner_directory(self):
        self.jobs.unlink()
        self.assertEqual(self.snapshot()["origin"]["jobState"], "deleted")
        self.jobs.parent.rmdir()
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unavailable")
        self.assertIsNone(controls._activity_inventory(self.home, self.home.parent / "other" / "cron" / "jobs.json"))

    def test_unclosed_runs_are_not_invented_failures_and_terminal_execution_binds_job(self):
        self.rows[0]["ended_at"] = None
        self.assertEqual(self.snapshot()["status"], "unknown")
        filename = self.home / "cron" / "executions.db"
        db = sqlite3.connect(filename)
        db.executescript("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT); INSERT INTO executions VALUES('fire-1','different-job','failed');")
        db.commit(); db.close()
        self.assertIsNone(controls._activity_terminal_execution(self.home, "deleted-job", "fire-1"))
        self.assertEqual(controls._activity_terminal_execution(self.home, "different-job", "fire-1"), "failed")
        self.identity["cron_job_id"] = "different-job"
        self.assertEqual(self.snapshot()["status"], "failed")
        self.assertEqual(self.snapshot()["origin"]["statusSource"], "execution-ledger")

    def test_wrong_profile_store_and_non_scheduler_rows_are_refused_and_closed(self):
        self.database.db_path = self.home.parent / "other" / "state.db"
        with self.assertRaises(Refusal):
            self.snapshot()
        self.assertTrue(self.closed)
        self.database.db_path = self.home / "state.db"
        self.rows[0]["source"] = "gui"
        with self.assertRaises(Refusal):
            self.snapshot()

    def test_invalid_or_aggregate_profile_and_unbounded_pages_never_read(self):
        for profile in (None, "all", "../other", "Writer"):
            with self.assertRaises(Refusal):
                asyncio.run(controls.scheduled_activity(profile))
        for values in ((-1, 100), (0, 101), (1000001, 10)):
            with self.assertRaises(Refusal):
                asyncio.run(controls.scheduled_activity("writer", *values))
        self.assertFalse(self.closed)

    def test_linked_and_hardlinked_job_inventories_are_not_treated_as_verified(self):
        other = self.home / "other-jobs.json"
        other.write_text('{"jobs":[]}', encoding="utf-8")
        self.jobs.unlink()
        try:
            self.jobs.symlink_to(other)
        except OSError:
            self.skipTest("Symlink creation requires Windows developer mode")
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unavailable")
        self.jobs.unlink()
        os.link(other, self.jobs)
        self.assertEqual(self.snapshot()["origin"]["jobState"], "unavailable")


if __name__ == "__main__":
    unittest.main()

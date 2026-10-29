"""Exercise version binding and uncertain decisions without starting a model or runtime."""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
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

    def test_failed_native_precondition_restores_proposal(self):
        _record, filename, body = self.seed()
        sys.modules["hermes_cli.write_approval_commands"]._apply_one = lambda *args: (False, "stale native preimage", {})
        with self.assertRaises(Refusal):
            controls.decide("memory", body)
        self.assertTrue(filename.exists())
        self.assertFalse(controls.audit_history())

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


if __name__ == "__main__":
    unittest.main()

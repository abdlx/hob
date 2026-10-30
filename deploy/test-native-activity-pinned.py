"""Read-only Activity integration with the actual pinned native session store.

Creates only temporary fixture state. The web DB opener is an explicit test
seam; native SessionDB, cron-store routing and profile ContextVars are real.
HTTP authentication/profile scope is separately tested. No inference.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types


root = Path(os.environ["HOB_QUALIFIED_RUNTIME"]).resolve()
with tempfile.TemporaryDirectory(prefix="hob-pinned-activity-") as temporary:
    home = Path(temporary)
    os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(root))
    from hermes_state import SessionDB

    database = home / "state.db"
    writer = SessionDB(db_path=database)
    try:
        linked = "cron_removed-job_20261030_104100"
        unlinked = "legacy-unlinked-run"
        for session_id in (linked, unlinked):
            writer.create_session(session_id, "cron")
            writer.set_session_title(session_id, "Original scheduler failure " + session_id)
            writer.append_message(session_id, "assistant", "Fixture failure", finish_reason="error")
            writer.end_session(session_id, "cron_incomplete_no_output")
    finally:
        writer.close()
    jobs = home / "cron" / "jobs.json"
    jobs.parent.mkdir(exist_ok=True)
    jobs.write_text('{"jobs":[]}', encoding="utf-8")
    before = database.read_bytes()

    homes = {"default": home}
    def open_db(profile, *, read_only):
        assert profile in homes and read_only is True
        return SessionDB(db_path=homes[profile] / "state.db", read_only=True)

    sys.modules["hermes_cli.web_server_sessions"] = types.SimpleNamespace(_open_session_db_for_profile=open_db)
    from cron.jobs import _current_cron_store
    assert Path(_current_cron_store().jobs_file).resolve() == jobs.resolve()
    spec = importlib.util.spec_from_file_location("controls", Path(__file__).with_name("hob-native-controls.py"))
    controls = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controls)
    feed = controls.scheduled_activity_snapshot("default")
    by_session = {item["sessionId"]: item for item in feed["items"]}
    assert by_session[linked]["status"] == "failed"
    assert by_session[linked]["origin"]["jobId"] == "removed-job"
    assert by_session[linked]["origin"]["jobState"] == "deleted"
    assert by_session[unlinked]["origin"]["jobState"] == "unlinked"
    assert database.read_bytes() == before, "Browsing changed native session history"
    jobs.write_text('{"jobs":[{"id":"removed-job","enabled":false}]}', encoding="utf-8")
    feed = controls.scheduled_activity_snapshot("default")
    assert next(item for item in feed["items"] if item["sessionId"] == linked)["origin"]["jobState"] == "present"
    broken = b'{"jobs": malformed'
    jobs.write_bytes(broken)
    feed = controls.scheduled_activity_snapshot("default")
    assert next(item for item in feed["items"] if item["sessionId"] == linked)["origin"]["jobState"] == "unavailable"
    assert jobs.read_bytes() == broken, "Browsing repaired or rewrote a scheduler inventory"
    assert database.read_bytes() == before, "Failure annotations changed native history"
    worker = home / "profiles" / "writer"
    worker.mkdir(parents=True)
    homes["writer"] = worker
    writer = SessionDB(db_path=worker / "state.db")
    try:
        writer.create_session(linked, "cron")
        writer.set_session_title(linked, "Worker's own historical run")
        writer.append_message(linked, "assistant", "Own failed result", finish_reason="error")
        writer.end_session(linked, "cron_incomplete_no_output")
    finally:
        writer.close()
    (worker / "cron").mkdir(exist_ok=True)
    (worker / "cron" / "jobs.json").write_text('{"jobs":[{"id":"removed-job","enabled":false}]}', encoding="utf-8")
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(worker)
    try:
        worker_feed = controls.scheduled_activity_snapshot("writer")
        assert len(worker_feed["items"]) == 1
        assert worker_feed["items"][0]["origin"]["profile"] == "writer"
        assert worker_feed["items"][0]["origin"]["jobState"] == "present", "Main's corrupt inventory leaked into another bot's check"
    finally:
        reset_hermes_home_override(token)
    assert jobs.read_bytes() == broken
    assert database.read_bytes() == before
    print("Pinned native Activity store: verified job identity, profile separation, original failures, deletion/outage distinction and read-only history")

"""Versioned reviews, schedule previews and read-only Activity provenance.

Mounted only by the checksum-guarded compatibility installer. Native stores,
appliers and scheduler remain the owners; this module adds a JSON projection.
"""
import hashlib
from datetime import datetime, timezone
import json
import os
import re
import stat
import threading
import time
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

router = APIRouter()
_lock = threading.RLock()


def revision(record):
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > 1024 * 1024:
        raise HTTPException(413, "Proposal is too large to review safely")
    return hashlib.sha256(encoded).hexdigest()


def private_promotion(record, profile=None):
    if record.get("team") is None:
        return None
    try:
        from agent.hob_team_retention import review_metadata
        return review_metadata(record, profile or "default")
    except Exception:
        raise HTTPException(409, "Private promotion provenance cannot be verified for this bot") from None


def subsystem_name(value):
    if value not in {"memory", "skills"}:
        raise HTTPException(400, "Choose memory or skills")
    return value


def proposal_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) or value == "all":
        raise HTTPException(400, "Choose one proposal")
    return value


def audit_path():
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home()).resolve()
    parent = home / ".hob"
    if parent.resolve() != parent:
        raise HTTPException(409, "Review audit directory must belong to this profile")
    return parent / "review-audit.jsonl"


def pending_path(subsystem, pending_id):
    from hermes_constants import get_hermes_home
    from tools import write_approval as native
    raw_home = Path(get_hermes_home()).absolute()
    home = raw_home.resolve()
    original = Path(native._pending_path(subsystem_name(subsystem), pending_id)).absolute()
    expected = home / "pending" / subsystem
    try:
        relative = original.relative_to(raw_home)
    except ValueError:
        raise HTTPException(409, "Pending store must belong to this profile")
    if relative != Path("pending") / subsystem / f"{pending_id}.json" or expected.resolve() != expected:
        raise HTTPException(409, "Pending store must be this profile's independent directory")
    return home / relative


def audit_history():
    filename = audit_path()
    if not filename.exists():
        return []
    if filename.is_symlink() or filename.stat().st_size > 8 * 1024 * 1024:
        raise HTTPException(409, "Review audit needs operator maintenance")
    entries = []
    for line in filename.read_text(encoding="utf-8").splitlines()[-1000:]:
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("Invalid audit record")
            entries.append(record)
        except ValueError:
            raise HTTPException(409, "Review audit is unreadable")
    return entries


def append_audit(record):
    filename = audit_path()
    filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(filename, flags, 0o600)
    try:
        if os.fstat(fd).st_nlink != 1:
            raise HTTPException(409, "Review audit must be an independent file")
        data = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
        written = os.write(fd, data)
        if written != len(data):
            raise HTTPException(503, "Review audit could not be persisted")
        os.fsync(fd)
    finally:
        os.close(fd)


def get_record(subsystem, pending_id):
    filename = pending_path(subsystem, proposal_id(pending_id))
    return read_record(filename, pending_id)


def read_record(filename, pending_id):
    try:
        fd = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        raise HTTPException(404, "Proposal is no longer pending")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024:
            raise HTTPException(409, "Proposal must be an independent, bounded file")
        with os.fdopen(fd, "r", encoding="utf-8-sig", closefd=False) as handle:
            record = json.loads(handle.read(1024 * 1024 + 1))
        after = os.fstat(fd)
        if after.st_mtime_ns != info.st_mtime_ns or after.st_size != info.st_size:
            raise HTTPException(409, "Proposal changed during review")
    except (ValueError, UnicodeError):
        raise HTTPException(409, "Proposal is unreadable")
    finally:
        os.close(fd)
    if not isinstance(record, dict) or record.get("id") != pending_id:
        raise HTTPException(404, "Proposal is no longer pending")
    return record


def claim_path(subsystem, pending_id, version):
    proposal_id(pending_id)
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{64}", version):
        raise HTTPException(400, "Choose an exact claimed revision")
    original = pending_path(subsystem, pending_id)
    return original.with_name(f".hob-claimed-{pending_id}-{version}.claim")


def get_claim(subsystem, pending_id, version):
    record = read_record(claim_path(subsystem, pending_id, version), pending_id)
    if revision(record) != version:
        raise HTTPException(409, "Claimed proposal changed; operator maintenance is required")
    return record


def reconcile_claim(subsystem, body):
    subsystem_name(subsystem)
    if not isinstance(body, dict) or set(body) != {"id", "revision", "action", "requestId", "confirm"} or body["confirm"] is not True:
        raise HTTPException(400, "Confirm inspection of the current native state")
    if any(not isinstance(body[key], str) for key in ["id", "revision", "action", "requestId"]):
        raise HTTPException(400, "Invalid operator observation")
    if body["action"] not in {"observed_applied", "abandoned"} or not isinstance(body["requestId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", body["requestId"]):
        raise HTTPException(400, "Choose a supported operator observation")
    filename = claim_path(subsystem, body["id"], body["revision"])
    with _lock:
        for previous in audit_history():
            if previous.get("requestId") == body["requestId"]:
                if previous.get("subsystem") != subsystem or any(previous.get(key) != body[key] for key in ["id", "revision", "action"]) or previous.get("status") != "operator_reconciled":
                    raise HTTPException(409, "Decision identifier was already used")
                if filename.exists():
                    get_claim(subsystem, body["id"], body["revision"])
                    filename.unlink()
                return {"ok": True, "decision": previous, "replayed": True}
        get_claim(subsystem, body["id"], body["revision"])
        decision = {"id": body["id"], "revision": body["revision"], "action": body["action"], "requestId": body["requestId"], "subsystem": subsystem, "at": time.time(), "status": "operator_reconciled"}
        append_audit(decision)
        filename.unlink()
        return {"ok": True, "decision": decision}


def decide(subsystem, body, profile=None):
    from hermes_cli.write_approval_commands import _apply_one
    from tools.memory_tool import load_on_disk_store
    subsystem_name(subsystem)
    required = {"id", "revision", "action", "requestId", "confirm"}
    if not isinstance(body, dict) or set(body) not in (required, required | {"confirmPrivatePromotion"}) or body["confirm"] is not True:
        raise HTTPException(400, "Confirm one exact proposal revision")
    if "confirmPrivatePromotion" in body and (body["confirmPrivatePromotion"] is not True or body.get("action") != "approve"):
        raise HTTPException(400, "Confirm private retention only for an approval")
    if any(not isinstance(body[key], str) for key in ["id", "revision", "action", "requestId"]):
        raise HTTPException(400, "Invalid review decision")
    pending_id = proposal_id(body["id"])
    if body["action"] not in {"approve", "reject"} or not re.fullmatch(r"[a-f0-9]{64}", str(body["revision"])) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", str(body["requestId"])):
        raise HTTPException(400, "Invalid review decision")
    with _lock:
        for previous in audit_history():
            if previous.get("requestId") == body["requestId"]:
                if previous.get("subsystem") != subsystem or any(previous.get(key) != body[key] for key in ["id", "revision", "action"]) or previous.get("privatePromotionConfirmed", False) != body.get("confirmPrivatePromotion", False):
                    raise HTTPException(409, "Decision identifier was already used")
                return {"ok": True, "decision": previous, "replayed": True}
        record = get_record(subsystem, pending_id)
        if revision(record) != body["revision"]:
            raise HTTPException(409, "Proposal changed; refresh and review again")
        promotion = private_promotion(record, profile)
        if promotion is not None and body["action"] == "approve":
            if body.get("confirmPrivatePromotion") is not True:
                raise HTTPException(400, "Confirm that this exact change may persist privately across chats")
            if subsystem == "skills":
                from agent.hob_team_retention import review_context, _skills_digest
                try:
                    with review_context(record, profile or "default"):
                        if record.get("privateSkillBase") != _skills_digest():
                            raise ValueError("changed")
                except Exception:
                    raise HTTPException(409, "Private skills changed; reject and recreate the proposal") from None
        original = pending_path(subsystem, pending_id)
        claimed = original.with_name(f".hob-claimed-{pending_id}-{body['revision']}.claim")
        if claimed.exists():
            raise HTTPException(409, "A prior decision needs reconciliation before another attempt")
        # Remove the item from the native queue atomically before calling its
        # applier. An interrupted claim is never blindly replayed on restart.
        try:
            os.link(original, claimed, follow_symlinks=False)
            fd = os.open(claimed, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 2 or info.st_size > 1024 * 1024:
                    raise HTTPException(409, "Proposal changed while claiming it")
                with os.fdopen(fd, "r", encoding="utf-8-sig", closefd=False) as handle:
                    claimed_revision = revision(json.loads(handle.read(1024 * 1024 + 1)))
            finally:
                os.close(fd)
            if claimed_revision != body["revision"]:
                claimed.unlink()
                raise HTTPException(409, "Proposal changed while claiming it")
            original.unlink()
        except FileNotFoundError:
            raise HTTPException(409, "Another reviewer already decided this proposal")
        except FileExistsError:
            raise HTTPException(409, "Another decision already claimed this proposal")
        if body["action"] == "approve":
            store = load_on_disk_store() if subsystem == "memory" else None
            ok, _error, _result = _apply_one(subsystem, record, store)
            if not ok:
                # Failure does not prove that the applier made no side effects.
                # Preserve the claim; never make an uncertain write replayable.
                raise HTTPException(409, "Native application was not confirmed; inspect current state and reconcile the claim")
        decision = {"id": pending_id, "revision": body["revision"], "action": body["action"], "requestId": body["requestId"], "subsystem": subsystem, "at": time.time(), "status": "completed"}
        if body.get("confirmPrivatePromotion"):
            decision["privatePromotionConfirmed"] = True
        if promotion is not None:
            decision["team"] = promotion
        append_audit(decision)
        claimed.unlink()
        return {"ok": True, "decision": decision}


async def scoped(profile, work):
    from hermes_cli.web_routers._common import scoped_to_thread
    return await scoped_to_thread(profile, work)


@router.get("/api/hob/reviews/{subsystem}")
async def pending(subsystem: str, profile: Optional[str] = None, offset: int = 0, limit: int = 50):
    subsystem_name(subsystem)
    if offset < 0 or offset > 10000 or limit < 1 or limit > 200:
        raise HTTPException(400, "Invalid proposal page")
    def work():
        from tools import write_approval as native
        directory = pending_path(subsystem, "").parent
        rows = [get_record(subsystem, row["id"]) for row in native.list_pending(subsystem)]
        items = [{"id": row["id"], "summary": str(row.get("summary", ""))[:500], "origin": str(row.get("origin", "foreground"))[:100], "createdAt": row.get("created_at"), "revision": revision(row)} for row in rows[offset:offset + limit]]
        claimed = list(directory.glob(".hob-claimed-*.claim"))
        claims = []
        for filename in sorted(claimed)[:50]:
            match = re.fullmatch(r"\.hob-claimed-([A-Za-z0-9_-]{1,128})-([a-f0-9]{64})\.claim", filename.name)
            if match:
                record = get_claim(subsystem, *match.groups())
                claims.append({"id": record["id"], "summary": str(record.get("summary", ""))[:500], "revision": match.group(2), "origin": "unconfirmed decision"})
        return {"items": items, "nextOffset": offset + limit if len(rows) > offset + limit else None, "unresolvedDecisions": len(claimed), "claims": claims}
    return await scoped(profile, work)


@router.get("/api/hob/reviews/{subsystem}/{pending_id}")
async def detail(subsystem: str, pending_id: str, profile: Optional[str] = None):
    subsystem_name(subsystem); proposal_id(pending_id)
    def work():
        from tools import write_approval as native
        record = get_record(subsystem, pending_id)
        promotion = private_promotion(record, profile)
        stale = False
        if promotion is not None and subsystem == "skills":
            diff = record.get("stagedDiff")
            if not isinstance(diff, str):
                raise HTTPException(409, "Private skill proposal has no reviewed source snapshot")
            try:
                from agent.hob_team_retention import review_context, _skills_digest
                with review_context(record, profile or "default"):
                    stale = record.get("privateSkillBase") != _skills_digest()
            except Exception:
                stale = True
        else:
            diff = native.skill_pending_diff(record) if subsystem == "skills" else json.dumps(record.get("payload", {}), ensure_ascii=False, indent=2)
        if len(diff.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(413, "Proposal diff exceeds the review limit")
        result = {"id": pending_id, "revision": revision(record), "summary": str(record.get("summary", "")), "diff": diff}
        if promotion is not None:
            result.update(team=promotion, stale=stale)
        return result
    return await scoped(profile, work)


@router.post("/api/hob/reviews/{subsystem}")
async def decision(subsystem: str, body: dict, profile: Optional[str] = None):
    return await scoped(profile, lambda: decide(subsystem, body, profile))


@router.get("/api/hob/review-claims/{subsystem}/{pending_id}/{version}")
async def claimed_detail(subsystem: str, pending_id: str, version: str, profile: Optional[str] = None):
    def work():
        record = get_claim(subsystem, pending_id, version)
        diff = json.dumps(record, ensure_ascii=False, indent=2)
        if len(diff.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(413, "Proposal diff exceeds the review limit")
        return {"id": pending_id, "revision": version, "summary": str(record.get("summary", ""))[:500], "diff": diff}
    return await scoped(profile, work)


@router.post("/api/hob/review-claims/{subsystem}")
async def claimed_observation(subsystem: str, body: dict, profile: Optional[str] = None):
    return await scoped(profile, lambda: reconcile_claim(subsystem, body))


@router.get("/api/hob/review-history")
async def history(profile: Optional[str] = None):
    return await scoped(profile, lambda: {"decisions": audit_history()[-100:]})


@router.post("/api/hob/schedule-preview")
async def schedule_preview(body: dict, profile: Optional[str] = None):
    if "schedule" not in body or set(body) - {"schedule", "after"} or not isinstance(body["schedule"], str) or len(body["schedule"]) > 200:
        raise HTTPException(400, "Enter one schedule")
    after = body.get("after")
    if after is not None:
        from datetime import datetime
        try:
            if not isinstance(after, str) or len(after) > 40 or datetime.fromisoformat(after).utcoffset() is None:
                raise ValueError("Explicit preview offset required")
        except ValueError:
            raise HTTPException(400, "Use an ISO preview reference with an explicit UTC offset")
    def work():
        from cron.jobs import parse_schedule, compute_next_run
        from hermes_time import get_timezone
        try:
            parsed = parse_schedule(body["schedule"])
            if after is not None and parsed.get("kind") == "once":
                raise HTTPException(400, "Reference-date previews apply only to recurring schedules")
            next_run = compute_next_run(parsed, last_run_at=after)
            zone = get_timezone()
            return {"valid": True, "schedule": parsed, "nextRun": next_run, "timezone": str(zone) if zone else "server local timezone"}
        except (ValueError, TypeError):
            raise HTTPException(400, "Hermes rejected this schedule")
    return await scoped(profile, work)


def _read_activity_file(filename, limit):
    """Bounded independent-file read. No repair/normalization side effects."""
    filename = Path(filename)
    for parent in [filename, *filename.parents]:
        if parent.is_symlink():
            raise ValueError("Linked activity source")
    fd = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("Invalid activity source")
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(data) > limit or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Activity source changed during read")
    return data


def _activity_inventory(home, jobs_file):
    # list_jobs() may normalize/repair malformed files. Browsing Activity must
    # not repair a scheduler store or treat a failed read as an empty inventory.
    home, jobs_file = Path(home).resolve(), Path(jobs_file).absolute()
    if jobs_file != home / "cron" / "jobs.json":
        return None
    try:
        data = json.loads(_read_activity_file(jobs_file, 4 * 1024 * 1024))
        jobs = data.get("jobs") if isinstance(data, dict) else None
        if not isinstance(jobs, list) or any(not isinstance(job, dict) or not isinstance(job.get("id"), str) or not job["id"] or job["id"] == "unknown" for job in jobs):
            return None
        # Includes disabled/paused jobs. Never infer deletion from a filtered list.
        return {job["id"] for job in jobs}
    except FileNotFoundError:
        # A verified absent file in the owner's independent cron directory is
        # an empty disk inventory. An unreadable/linked/missing directory is not.
        parent = jobs_file.parent
        try:
            return set() if parent.is_dir() and not parent.is_symlink() and parent.resolve() == parent else None
        except OSError:
            return None
    except (OSError, ValueError, UnicodeError):
        return None


def _activity_terminal_execution(home, job_id, execution_id):
    if not job_id or not execution_id:
        return None
    filename = Path(home) / "cron" / "executions.db"
    try:
        if any(parent.is_symlink() for parent in [filename, *filename.parents]) or not filename.is_file() or filename.stat().st_nlink != 1:
            return None
        # The ledger's normal connection initializes/migrates its schema. Keep
        # this projection strictly read-only and bind BOTH job and execution.
        from contextlib import closing
        with closing(sqlite3.connect(filename.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT status FROM executions WHERE id=? AND job_id=?", (execution_id, job_id)).fetchone()
            return row[0] if row and row[0] in {"completed", "failed", "unknown"} else None
    except (OSError, sqlite3.Error):
        return None


def scheduled_activity_snapshot(profile, offset=0, limit=100):
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    from cron.jobs import _current_cron_store
    home = Path(get_hermes_home()).resolve()
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        if Path(db.db_path).resolve().parent != home:
            raise HTTPException(503, "Scheduler history belongs to another profile")
        rows = db.list_sessions_rich(sources=["cron"], limit=limit, offset=offset, order_by_last_active=True, compact_rows=True)
        statuses = db.session_lifecycle_statuses([row["id"] for row in rows])
        inventory = _activity_inventory(home, _current_cron_store().jobs_file)
        observed = datetime.now(timezone.utc).isoformat()
        items = []
        for row in rows:
            if row.get("source") != "cron":
                raise HTTPException(503, "Scheduler history returned another source")
            identity_error = False
            try:
                identity = db.cron_run_identity(row["id"]) or {}
            except Exception:
                identity, identity_error = {}, True
            job_id, execution_id = identity.get("cron_job_id"), identity.get("cron_execution_id")
            if job_id in ("", "unknown"):
                job_id = None
            job_state = "unavailable" if identity_error else "unlinked" if not job_id else "unavailable" if inventory is None else "present" if job_id in inventory else "deleted"
            lifecycle = statuses.get(row["id"], "empty")
            terminal = _activity_terminal_execution(home, job_id, execution_id)
            status = terminal or ({"complete": "completed", "error": "failed", "interrupted": "interrupted"}.get(lifecycle, "unknown") if row.get("ended_at") is not None else "unknown")
            items.append({"sessionId": row["id"], "title": str(row.get("title") or "Scheduled run")[:500],
                "timestamp": row.get("last_active") or row.get("started_at"), "status": status,
                "origin": {"kind": "scheduled-job", "profile": profile, "sessionId": row["id"],
                    "jobId": job_id, "executionId": execution_id, "jobState": job_state,
                    "historical": row.get("ended_at") is not None, "observedAt": observed, "inventoryStatus": "verified" if inventory is not None else "unavailable",
                    "nativeStatus": terminal or lifecycle, "statusSource": "execution-ledger" if terminal else "session-lifecycle"}})
        return {"items": items, "nextOffset": offset + len(rows) if len(rows) == limit else None}
    finally:
        db.close()


@router.get("/api/hob/activity")
async def scheduled_activity(profile: Optional[str] = None, offset: int = 0, limit: int = 100):
    if not isinstance(profile, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile) or profile == "all":
        raise HTTPException(400, "Scheduler history requires one explicit profile")
    if type(offset) is not int or offset < 0 or offset > 1000000 or type(limit) is not int or not 1 <= limit <= 100:
        raise HTTPException(400, "Use a bounded scheduler history page")
    return await scoped(profile, lambda: scheduled_activity_snapshot(profile, offset, limit))

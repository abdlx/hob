"""Versioned review and schedule previews for the qualified Hermes runtime.

Mounted only by the checksum-guarded compatibility installer. Native stores,
appliers and scheduler remain the owners; this module adds a JSON projection.
"""
import hashlib
import json
import os
import re
import stat
import threading
import time
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


def decide(subsystem, body):
    from hermes_cli.write_approval_commands import _apply_one
    from tools.memory_tool import load_on_disk_store
    subsystem_name(subsystem)
    if not isinstance(body, dict) or set(body) != {"id", "revision", "action", "requestId", "confirm"} or body["confirm"] is not True:
        raise HTTPException(400, "Confirm one exact proposal revision")
    if any(not isinstance(body[key], str) for key in ["id", "revision", "action", "requestId"]):
        raise HTTPException(400, "Invalid review decision")
    pending_id = proposal_id(body["id"])
    if body["action"] not in {"approve", "reject"} or not re.fullmatch(r"[a-f0-9]{64}", str(body["revision"])) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", str(body["requestId"])):
        raise HTTPException(400, "Invalid review decision")
    with _lock:
        for previous in audit_history():
            if previous.get("requestId") == body["requestId"]:
                if previous.get("subsystem") != subsystem or any(previous.get(key) != body[key] for key in ["id", "revision", "action"]):
                    raise HTTPException(409, "Decision identifier was already used")
                return {"ok": True, "decision": previous, "replayed": True}
        record = get_record(subsystem, pending_id)
        if revision(record) != body["revision"]:
            raise HTTPException(409, "Proposal changed; refresh and review again")
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
        diff = native.skill_pending_diff(record) if subsystem == "skills" else json.dumps(record.get("payload", {}), ensure_ascii=False, indent=2)
        if len(diff.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(413, "Proposal diff exceeds the review limit")
        return {"id": pending_id, "revision": revision(record), "summary": str(record.get("summary", "")), "diff": diff}
    return await scoped(profile, work)


@router.post("/api/hob/reviews/{subsystem}")
async def decision(subsystem: str, body: dict, profile: Optional[str] = None):
    return await scoped(profile, lambda: decide(subsystem, body))


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

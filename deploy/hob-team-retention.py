"""Source-checked private learning and session-bound promotion records.

This extends the native write owner; approved writes still use the native
memory/skill appliers. It does not authorize writes to shared team core.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import ctypes
from datetime import datetime, timezone
import errno
from functools import wraps
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
from types import SimpleNamespace
import uuid

from agent import hob_team_context as context

_turn = ContextVar("hob_team_private_retention_turn", default=None)
_review_home = ContextVar("hob_team_private_review_home", default=None)
_eligible_memory = ContextVar("hob_team_eligible_private_memory", default=False)
_lock = threading.RLock()
_SECRET = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b", re.I)
_ASSIGNMENT = re.compile(r"(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)[\"']?\s*[=:]\s*(?P<quote>[\"']?)(?P<value>[^\s\"']{8,})", re.I)


def _sensitive(value):
    if isinstance(value, dict):
        return any(_sensitive(item) for item in value.values())
    if isinstance(value, list):
        return any(_sensitive(item) for item in value)
    if not isinstance(value, str):
        return False
    if _SECRET.search(value):
        return True
    for match in _ASSIGNMENT.finditer(value):
        candidate = match.group("value")
        if re.fullmatch(r"\$\{[A-Z_][A-Z0-9_]*\}", candidate):
            continue
        if not match.group("quote") and candidate.startswith(("os.environ", "os.getenv(", "process.env.", "Deno.env.", "$")):
            continue
        return True
    return False


def _home_digest(home):
    return hashlib.sha256(str(Path(home).resolve()).encode()).hexdigest()


def _independent_path(target):
    target = Path(target).absolute()
    for path in [*reversed(target.parents), target]:
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
            raise context.TeamContextError("Private retention paths must be independent and unlinked.")


def private_skill_root():
    home = _review_home.get()
    if home is None:
        state = context._state()
        if state is None:
            if _turn.get():
                raise context.TeamContextError("Team private-retention authority was disabled during this turn.")
            return None
        if state["kind"] == "group":
            raise context.TeamContextError("Group context cannot read private skill roots.")
        home = state["metadata"]["home"]
    root = Path(home) / "skills"
    _independent_path(root)
    return root


def review_metadata(record, expected_profile=None):
    value = record.get("team")
    if value is None:
        return None
    keys = {"version", "profile", "session", "kind", "retention", "homeDigest"}
    if (not isinstance(value, dict) or set(value) != keys or type(value["version"]) is not int or value["version"] != 1
            or not isinstance(value["profile"], str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value["profile"])
            or not isinstance(value["session"], str) or not 1 <= len(value["session"]) <= 512
            or value["kind"] not in ("user", "relay") or value["retention"] != "pending-private-promotion"
            or expected_profile is not None and value["profile"] != expected_profile):
        raise context.TeamContextError("Private promotion provenance is invalid or belongs to another bot.")
    from hermes_constants import get_hermes_home
    if value["homeDigest"] != _home_digest(get_hermes_home()):
        raise context.TeamContextError("Private promotion belongs to another native home.")
    return dict(value)


@contextmanager
def review_context(record, expected_profile=None):
    metadata = review_metadata(record, expected_profile)
    if metadata is None:
        yield None
        return
    from hermes_constants import get_hermes_home
    token = _review_home.set(Path(get_hermes_home()))
    try:
        yield metadata
    finally:
        _review_home.reset(token)


def _skills_digest():
    root = private_skill_root()
    if root is None:
        raise context.TeamContextError("Private skill review scope is unavailable.")
    digest = hashlib.sha256()
    if not root.exists():
        return hashlib.sha256(b"missing-private-skills").hexdigest()
    if not root.is_dir():
        raise context.TeamContextError("Private skills root must be a directory.")
    from agent.skill_utils import EXCLUDED_SKILL_DIRS
    count = total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        digest.update(b"D" + Path(directory).relative_to(root).as_posix().encode() + b"\0")
        dirs[:] = sorted(name for name in dirs if name not in EXCLUDED_SKILL_DIRS)
        for name in dirs:
            _independent_path(Path(directory) / name)
        for name in sorted(files):
            path = Path(directory) / name
            _independent_path(path)
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as handle:
                before = os.fstat(handle.fileno())
                count += 1; total += before.st_size
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or count > 8192 or total > 128 * 1024 * 1024:
                    raise context.TeamContextError("Private skill source exceeds safe review bounds.")
                digest.update(path.relative_to(root).as_posix().encode() + b"\0")
                while chunk := handle.read(65536):
                    digest.update(chunk)
                after = os.fstat(handle.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise context.TeamContextError("Private skill source changed during review.")
                digest.update(b"\0")
    return digest.hexdigest()


def review_application(function):
    @wraps(function)
    def apply(subsystem, record, *args, **kwargs):
        try:
            with review_context(record) as metadata:
                if metadata is not None:
                    if subsystem == "skills" and record.get("privateSkillBase") != _skills_digest():
                        return False, "Private skills changed; reject and recreate the proposal.", {}
                    if subsystem == "memory":
                        from hermes_constants import get_hermes_home
                        for name in ("USER.md", "MEMORY.md"):
                            _independent_path(Path(get_hermes_home()) / "memories" / name)
                return function(subsystem, record, *args, **kwargs)
        except context.TeamContextError as error:
            return False, str(error), {}
    return apply


def turn_scope(function):
    @wraps(function)
    def run(*args, **kwargs):
        token = _turn.set(None)
        try:
            return function(*args, **kwargs)
        finally:
            frame = _turn.get()
            if frame is not None:
                frame["active"] = False
            _turn.reset(token)
    return run


def bind_turn(agent, state):
    _turn.set(None if state is None else {
        "authority": state["authority"], "profile": state["profile"], "home": state["metadata"]["home"],
        "session": agent.session_id, "kind": state["kind"], "observations": set(), "active": True,
    })


def _scope():
    bound = _turn.get()
    if bound is not None and not bound["active"]:
        raise context.TeamContextError("Private retention turn has already ended.")
    state = context._state(SimpleNamespace(session_id=bound["session"])) if bound else context._state()
    if state is None:
        if bound:
            raise context.TeamContextError("Team private-retention authority was disabled during this turn.")
        return None
    if not bound or any(bound[key] != state[key] for key in ("authority", "profile", "kind")) or Path(bound["home"]).resolve() != Path(state["metadata"]["home"]).resolve():
        raise context.TeamContextError("Private promotion requires a trusted bound team turn.")
    from tools.skill_provenance import get_current_write_origin
    if state["kind"] not in ("user", "relay") or get_current_write_origin() not in ("foreground", "assistant_tool"):
        raise context.TeamContextError("Group, background and unbound work cannot propose private retention.")
    return bound


def decision(subsystem, decision_type):
    if _scope() is None:
        return None
    if subsystem not in ("memory", "skills"):
        raise context.TeamContextError("Unknown private-retention subsystem.")
    if subsystem == "memory" and _eligible_memory.get():
        return None  # Preserve the user's native approval setting for eligible notes.
    return decision_type(stage=True, message=(
        "This change needs your review before it becomes private memory or a skill across chats. "
        "Nothing is committed yet. Review the exact proposal in Settings."))


def observe_tool(agent, function_name, status):
    labels = {"terminal": "terminal", "read_file": "file reader", "file_read": "file reader", "write_file": "file writer",
              "file_write": "file writer", "file_edit": "file editor", "web_search": "web search", "web_fetch": "web fetch",
              "browser_navigate": "browser navigation", "browser_snapshot": "browser snapshot"}
    outcomes = {"success": "completed", "completed": "completed", "ok": "completed", "error": "failed", "failed": "failed",
                "blocked": "was blocked", "timeout": "timed out", "interrupted": "was interrupted"}
    if not isinstance(function_name, str) or not isinstance(status, str) or function_name not in labels or status not in outcomes:
        return
    try:
        scope = _scope()
        if scope is None or agent.session_id != scope["session"]:
            return
        with _lock:
            if len(scope["observations"]) < 64:
                observed = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                scope["observations"].add(f"Tool observation at {observed}: {labels[function_name]} {outcomes[status]}.")
    except Exception:
        # An observer never turns a completed tool into a failed one. Missing
        # authority still refuses the subsequent private write at its own gate.
        return


def learning_evidence():
    scope = _turn.get()
    if not scope or not scope["active"] or scope["kind"] not in ("user", "relay"):
        return ""
    with _lock:
        observations = sorted(scope["observations"])
    if not observations:
        return ""
    return "Verified own task observations eligible for private memory (not user facts):\n" + "\n".join(observations)


def _eligible_note(scope, text):
    if not isinstance(text, str) or not text.strip() or _sensitive(text):
        return False
    with _lock:
        if text in scope["observations"]:
            return True
    # Skill text is already retained procedural knowledge. Copying an exact
    # excerpt does not grant persistence to a new user/chat fact or a paraphrase.
    if len(text.strip()) < 24:
        return False
    root = private_skill_root()
    if root is None or not root.is_dir():
        return False
    count = total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        from agent.skill_utils import EXCLUDED_SKILL_DIRS
        dirs[:] = [name for name in dirs if name not in EXCLUDED_SKILL_DIRS]
        for name in dirs:
            _independent_path(Path(directory) / name)
        if "SKILL.md" not in files:
            continue
        path = Path(directory) / "SKILL.md"
        _independent_path(path)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            count += 1; total += info.st_size
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024 or count > 8192 or total > 128 * 1024 * 1024:
                raise context.TeamContextError("Private learning source exceeds safe bounds.")
            value = handle.read(info.st_size + 1)
            after = os.fstat(handle.fileno())
            if len(value) != info.st_size or (info.st_mtime_ns, info.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
                raise context.TeamContextError("Private learning source changed during admission.")
        if text in value.decode("utf-8", errors="strict"):
            return True
    return False


def memory_gate(function):
    @wraps(function)
    def run(store, summary, detail, payload):
        scope = _scope()
        eligible = False
        if scope is not None:
            operations = payload.get("operations") if payload.get("action") == "batch" else [payload]
            if isinstance(operations, list) and operations:
                try:
                    eligible = all(isinstance(op, dict) and (op.get("action") == "remove" or (
                        op.get("action") == "add" and payload.get("target") == "memory"
                        and _eligible_note(scope, op.get("content") or op.get("new_text")))) for op in operations)
                except (OSError, UnicodeError, context.TeamContextError):
                    eligible = False  # Unavailable sources grant no autonomous write.
        token = _eligible_memory.set(eligible)
        try:
            return function(store, summary, detail, payload)
        finally:
            _eligible_memory.reset(token)
    return run


@contextmanager
def _directory(home, subsystem):
    root = Path(home).absolute()
    if os.name == "nt":
        for parent in [*reversed(root.parents), root]:
            if parent.is_symlink():
                raise context.TeamContextError("Linked private-retention directories are refused.")
        if not root.is_dir():
            raise context.TeamContextError("Private native home is unavailable.")
        target = root
        for part in ("pending", subsystem):
            target = target / part
            if target.is_symlink():
                raise context.TeamContextError("Linked private-retention directories are refused.")
            target.mkdir(mode=0o700, exist_ok=True)
        yield None, target
        return
    fd = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = [*root.parts[1:], "pending", subsystem]
        for index, part in enumerate(parts):
            if index >= len(parts) - 2:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, Path("/proc/self/fd") / str(fd)
    finally:
        os.close(fd)


def _publish(fd, directory, temporary, final):
    if fd is None:
        os.rename(directory / temporary, directory / final)  # Windows refuses an existing destination.
        return
    # One atomic, no-overwrite publication. No hardlink window or copy fallback.
    rename = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if rename is None:
        raise context.TeamContextError("Safe private-proposal publication is unavailable.")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(fd, temporary.encode(), fd, final.encode(), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise context.TeamContextError("Private proposal identity collided; retry without replacing it.")
        raise OSError(code, "Private proposal could not be published")


def _assert_directory(home, subsystem, directory_fd):
    root = Path(home).absolute()
    target = root / "pending" / subsystem
    for parent in [*reversed(root.parents), root, root / "pending", target]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise context.TeamContextError("Private pending directory changed during staging.")
    if directory_fd is not None:
        pinned = os.fstat(directory_fd)
        if (info.st_dev, info.st_ino) != (pinned.st_dev, pinned.st_ino):
            raise context.TeamContextError("Private pending directory changed during staging.")


def stage_write(subsystem, payload, *, summary, origin):
    scope = _scope()
    if scope is None:
        return None
    if subsystem not in ("memory", "skills") or origin not in ("foreground", "assistant_tool") or not isinstance(payload, dict):
        raise context.TeamContextError("Only foreground private proposals can be staged.")
    pending_id = uuid.uuid4().hex
    record = {"id": pending_id, "subsystem": subsystem, "action": payload.get("action", ""),
        "summary": (summary or "").strip(), "origin": origin, "created_at": time.time(), "payload": payload,
        "team": {"version": 1, "profile": scope["profile"], "session": scope["session"], "kind": scope["kind"], "retention": "pending-private-promotion", "homeDigest": _home_digest(scope["home"])}}
    if subsystem == "skills":
        from tools import write_approval
        record["privateSkillBase"] = _skills_digest()
        record["stagedDiff"] = write_approval.skill_pending_diff(record)
        if not isinstance(record["stagedDiff"], str):
            raise context.TeamContextError("Native private skill diff is unavailable.")
        if record["privateSkillBase"] != _skills_digest():
            raise context.TeamContextError("Private skills changed while staging; retry the proposal.")
    try:
        encoded = json.dumps(record, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError):
        raise context.TeamContextError("Private proposal must be valid UTF-8 JSON.") from None
    if len(encoded) > 1024 * 1024 or _sensitive(record):
        raise context.TeamContextError("Oversized proposals and potential credentials cannot be staged for retention.")
    with _lock, _directory(scope["home"], subsystem) as (directory_fd, directory):
        if sum(name.endswith(".json") for name in os.listdir(directory)) >= 128:
            raise context.TeamContextError("Review pending private proposals before staging more.")
        temporary, final = ".hob-stage-" + uuid.uuid4().hex, pending_id + ".json"
        target = directory / temporary
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            _scope()  # A revoked profile/authority cannot publish its queued write.
            _assert_directory(scope["home"], subsystem, directory_fd)
            _publish(directory_fd, directory, temporary, final)
            if directory_fd is not None:
                os.fsync(directory_fd)
            fd = os.open(directory / final, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != len(encoded) or handle.read(len(encoded) + 1) != encoded:
                    raise context.TeamContextError("Private proposal persistence could not be verified.")
            _assert_directory(scope["home"], subsystem, directory_fd)
        finally:
            try:
                target.unlink()
            except FileNotFoundError:
                pass
    return record

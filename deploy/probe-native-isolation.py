"""Actual native tool owners and SSH principals, only in disposable image CI.

No model, external provider or production state. A unique fixture bot is
created/deleted through authenticated dashboard APIs by the smoke harness.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import socket
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import uuid

assert sys.platform == "linux" and os.environ.get("HOB_SMOKE_NATIVE_ISOLATION") == "1"
profile = os.environ["HOB_NATIVE_ISOLATION_PROFILE"]
assert re.fullmatch(r"native-isolation-[a-f0-9]{12}", profile)
owners = {row["profile"]: row for row in json.loads(sys.stdin.read(16384))}
assert set(owners) == {"default", profile}
assert owners["default"]["uid"] != owners[profile]["uid"]
assert os.getuid() == 10000
home = Path("/opt/data")
state = Path(owners["default"]["keyPath"]).parent.parent
assert state.is_relative_to(home)
nonce = uuid.uuid4().hex
private = []
ssh_spawns = []

def audit(event, args):
    if event == "subprocess.Popen":
        executable = Path(str(args[0])).name
        if executable in ("ssh", "scp"):
            ssh_spawns.append(executable)
sys.addaudithook(audit)

# Python helpers may use only the root broker; actual SSH is the pinned native
# backend's child process, whose final endpoint is guarded below.
original_connect = socket.socket.connect
def connect(sock, address):
    assert sock.family == socket.AF_UNIX and address == "/run/hob-isolation/broker.sock", "Unexpected Python network access"
    return original_connect(sock, address)
socket.socket.connect = connect

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from gateway.session_context import set_session_vars, clear_session_vars
from tools.terminal_scope import install_profile_terminal_scope, reset_terminal_scope, set_terminal_scope
from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
from tools import terminal_tool as terminal, file_tools as files
from agent import hob_team_context as context, hob_team_retention as retention, hob_team_isolation as guard


@contextmanager
def routed(name):
    native_home = home if name == "default" else home / "profiles" / name
    token = set_hermes_home_override(native_home)
    scope = install_profile_terminal_scope(native_home)
    session = set_session_vars(platform="web", profile=name, session_id="native-isolation", session_key="same-session-key", cwd=owners[name]["workspace"])
    origin = set_current_write_origin("foreground")
    frame = retention._turn.set(None)
    try:
        context.turn_start(SimpleNamespace(session_id="native-isolation", api_mode="chat_completions"))
        yield
    finally:
        bound = retention._turn.get()
        if bound is not None:
            bound["active"] = False
        retention._turn.reset(frame)
        reset_current_write_origin(origin)
        clear_session_vars(session)
        reset_terminal_scope(scope)
        reset_hermes_home_override(token)


def call(name, **args):
    handler = {"terminal": terminal._handle_terminal, "read_file": files._handle_read_file,
               "write_file": files._handle_write_file, "patch": files._handle_patch,
               "search_files": files._handle_search_files}[name]
    value = handler(args, task_id="same-task-id", session_id="native-isolation")
    return json.loads(value) if isinstance(value, str) else value


def command(argv):
    result = call("terminal", command=shlex.join(argv), timeout=20)
    assert result.get("exit_code") == 0, "Native terminal did not confirm the fixture command"
    return result.get("output", "")


def denied(name, **args):
    try:
        result = call(name, **args)
    except context.TeamContextError:
        return
    assert result.get("error") or result.get("success") is False or result.get("status") in ("error", "blocked", "disabled"), "Native tool reported success for a refused operation"


with tempfile.TemporaryDirectory(prefix="native-isolation-", dir=state) as temporary:
    root = Path(temporary)
    # Same parent for the broker-owned key authority. This private probe DB
    # deliberately does not modify the application's real team settings.
    authority = state / ("native-isolation-" + nonce + ".sqlite")
    db = sqlite3.connect(authority)
    previous_tmp = tempfile.tempdir
    # Native SSH ControlMaster names otherwise collide with the gateway's
    # live connections for the same bot. Give only this probe its own clients.
    tempfile.tempdir = str(root)
    os.chmod(authority, 0o600)
    os.environ["HERMES_HOB_TEAM_STATE_DB"] = str(authority)
    db.executescript("""
        CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);
        CREATE TABLE runtime_profiles(profile TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE runtime_sessions(profile TEXT,session TEXT,kind TEXT,assignment TEXT);
        CREATE TABLE core_versions(revision INTEGER,content TEXT,digest TEXT);
    """)
    db.execute("INSERT INTO settings VALUES(1,?)", (json.dumps({"nativeContext": True, "sessionWindow": 20, "coreBudget": 4000}),))
    work_files = {}
    memories = {}
    canaries = {}
    for name, owner in owners.items():
        native_home = home if name == "default" else home / "profiles" / name
        assert owner["workspace"] == str(Path("/var/lib/hob-isolation/workspaces") / ("main" if name == "default" else "bots/" + name))
        db.execute("INSERT INTO runtime_profiles VALUES(?,?)", (name, json.dumps({"name": name, "role": "", "roster": [], "home": str(native_home), "workspace": owner["workspace"]})))
        db.execute("INSERT INTO runtime_sessions VALUES(?,'native-isolation','user','')", (name,))
        memories[name] = native_home / "memories" / ("native-isolation-" + nonce + ".txt")
        memories[name].parent.mkdir(exist_ok=True)
        fd = os.open(memories[name], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        canaries[name] = "PRIVATE_NATIVE_" + name + "_" + nonce
        with os.fdopen(fd, "w") as handle:
            handle.write(canaries[name])
        private.append(memories[name])
        work_files[name] = Path(owner["workspace"]) / ("native-isolation-" + nonce + ".txt")
    db.commit()
    first_env = None
    try:
        # Reuse a task/session id across profiles, then return to Main without
        # clearing native caches. Both the kernel UID and file contents must fit.
        for name in ("default", profile, "default"):
            with routed(name):
                owner = owners[name]
                identity = json.loads(command(["python3", "-c", "import os,json;print(json.dumps({'uid':os.getuid(),'forbidden':[k for k in ('API_SERVER_KEY','HOB_TALK_TOKEN','HERMES_HOB_TEAM_STATE_DB') if k in os.environ]}))"]))
                assert identity == {"uid": owner["uid"], "forbidden": []}
                operations = files._get_file_ops("same-task-id")
                if name == "default" and first_env is None:
                    first_env = operations.env
                elif name == "default":
                    assert operations.env is first_env, "Main's native environment was replaced while switching profiles"
                    assert "PATCHED_" + name in json.dumps(call("read_file", path=str(work_files[name])))
                    assert "PATCHED_" + profile not in json.dumps(call("read_file", path=str(work_files[profile]))), "Main read a worker's private workspace"
                    denied("write_file", path=str(work_files[profile]), content="FORBIDDEN_WRITE", cross_profile=True)
                    continue
                result = call("write_file", path=str(work_files[name]), content="ORIGINAL_" + name + "\n")
                assert not result.get("error") and result.get("bytes_written") == len(("ORIGINAL_" + name + "\n").encode()), "Own native file creation failed: " + str(result.get("error", "unconfirmed byte count"))[:400]
                assert "ORIGINAL_" + name in json.dumps(call("read_file", path=str(work_files[name])))
                result = call("patch", path=str(work_files[name]), old_string="ORIGINAL_" + name, new_string="PATCHED_" + name)
                assert result.get("success") is True, "Own native patch failed"
                assert "PATCHED_" + name in json.dumps(call("search_files", path=owner["workspace"], pattern="PATCHED_" + name, file_glob=work_files[name].name))
                other = profile if name == "default" else "default"
                for path in (memories[name], memories[other], authority, work_files[other]):
                    read = call("read_file", path=str(path))
                    assert not any(canary in json.dumps(read) for canary in canaries.values()), "Native read disclosed a private memory canary"
                    denied("write_file", path=str(path), content="FORBIDDEN_WRITE", cross_profile=True)
                    denied("patch", path=str(path), old_string="PRIVATE_NATIVE", new_string="FORBIDDEN_PATCH", cross_profile=True)
                    access = command(["python3", "-c", "import os,json,sys;print(json.dumps([os.access(sys.argv[1],os.R_OK),os.access(sys.argv[1],os.W_OK)]))", str(path)])
                    assert json.loads(access) == [False, False], "Kernel credentials allowed a protected path"
                found = call("search_files", path=owners[other]["workspace"], pattern=nonce)
                assert "PATCHED_" + other not in json.dumps(found), "Native search disclosed another bot's file"
                link = Path(owner["workspace"]) / ("native-isolation-link-" + nonce)
                command(["ln", "-s", str(memories[other]), str(link)])
                assert canaries[other] not in json.dumps(call("read_file", path=str(link))), "Linked path disclosed private content"
                command(["rm", "-f", "--", str(link)])
        with routed(profile):
            # A local policy override cannot turn a missing/changed SSH policy
            # into execution as the trusted operator, even with warm caches.
            local = set_terminal_scope({"TERMINAL_ENV": "local", "TERMINAL_CWD": str(root)})
            try:
                denied("terminal", command="printf forbidden")
                denied("read_file", path=str(memories[profile]))
            finally:
                reset_terminal_scope(local)
            # Poison the native file cache with Main's real executor.
            key = terminal._resolve_container_task_id("same-task-id")
            cached_terminal = terminal._active_environments[key]
            terminal._active_environments[key] = first_env
            try:
                denied("terminal", command="printf forbidden")
            finally:
                terminal._active_environments[key] = cached_terminal
            original = files._file_ops_cache[key]
            files._file_ops_cache[key] = SimpleNamespace(env=first_env)
            try:
                denied("read_file", path=str(work_files["default"]))
            finally:
                files._file_ops_cache[key] = original
            # Leave this fixture's native SSH cache warm, revoke its actual
            # principal, then prove native calls refuse before reconnecting.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(10); client.connect("/run/hob-isolation/broker.sock")
                client.sendall(json.dumps({"version": 1, "operation": "revoke", "profile": profile}).encode() + b"\n")
                assert json.loads(client.recv(16384))["ok"] is True
            spawns = len(ssh_spawns)
            denied("terminal", command="printf forbidden")
            denied("read_file", path=str(work_files[profile]))
            assert len(ssh_spawns) == spawns, "Revoked native tools attempted another SSH connection"
        for name, path in memories.items():
            assert path.read_text() == canaries[name], "Protected private bytes changed"
        print(json.dumps({"nativeFileTools": ["read_file", "write_file", "patch", "search_files"], "nativeTerminal": True,
                          "distinctUids": True, "crossBotAndPrivateStateDenied": True, "cachedOwnerChecked": True,
                          "localFallbackDenied": True, "revocationDeniedBeforeReconnect": True}))
    finally:
        terminal.cleanup_all_environments()
        tempfile.tempdir = previous_tmp
        db.close()
        authority.unlink(missing_ok=True)
        for path in private:
            path.unlink(missing_ok=True)
        # These exact, nonce-bound fixture paths are all under verified bot
        # workspaces; no directory tree or unrelated workspace file is removed.
        for name, path in work_files.items():
            assert path.parent == Path(owners[name]["workspace"]) and path.name == "native-isolation-" + nonce + ".txt"
            path.unlink(missing_ok=True)

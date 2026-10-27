"""Linux-only privilege separation for bot shells and Chromium.

The trusted Hermes gateway stays under its existing operator UID. Model-issued
terminal/file/code calls use native SSH under a distinct UID for each bot, and
Chromium runs under that same bot UID. The private broker accepts only the
operator UID over a mode-0600 Unix socket. It never accepts an arbitrary command,
executable, UID, mount, shell fragment or environment from a request.
"""
from __future__ import annotations

import contextlib
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time

PROFILE = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
SOCKET = "/run/hob-isolation/broker.sock"
SSH_PORT = 22220
PRIVATE = Path("/var/lib/hob-isolation")
FD_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
DIR_FLAGS = FD_FLAGS | getattr(os, "O_DIRECTORY", 0)
BROWSER_FLAGS = frozenset({"--headless=new", "--remote-debugging-pipe", "--disable-blink-features=AutomationControlled",
    "--restore-last-session", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-sync", "--disable-translate",
    "--disable-extensions", "--disable-plugins", "--disable-gpu", "--metrics-recording-only", "--mute-audio"})


def profile_name(value):
    if not isinstance(value, str) or PROFILE.fullmatch(value) is None:
        raise ValueError("invalid_profile")
    return value


def read_regular(filename, owner, limit=1024 * 1024):
    fd = os.open(filename, FD_FLAGS)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner or info.st_size > limit:
            raise ValueError("unsafe_state_file")
        value = os.read(fd, limit + 1)
        if len(value) > limit:
            raise ValueError("oversized_state_file")
        return value
    finally:
        os.close(fd)


def atomic_at(directory_fd, name, value, uid, gid, mode=0o600):
    """All writes are relative to a pinned directory; never chown a pathname."""
    temporary = ".hob-" + os.urandom(16).hex()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory_fd)
    try:
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.rename(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory_fd)


def run(argv):
    # No shell and no inherited provider/application credentials.
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}, timeout=30)
    if result.returncode:
        raise RuntimeError("isolation_setup_failed:" + Path(argv[0]).name)
    return result.stdout


def directory_at(parent_fd, name, owner, gid, *, create=True):
    if not name or "/" in name or name in (".", ".."):
        raise ValueError("invalid_directory")
    created = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
        except FileExistsError:
            pass
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, owner, gid):
        os.close(fd)
        raise ValueError("unsafe_directory")
    if created:
        os.fchown(fd, owner, gid)
    return fd


def acl(fd, *entries, default=False):
    run(["/usr/bin/setfacl", *( ["-d"] if default else [] ), "-m", ",".join(entries), f"/proc/{os.getpid()}/fd/{fd}"])


def migrate_tree(fd, bot_uid, operator_uid, operator_gid):
    """Adopt only independent regular files. Reject links before privileged
    ownership changes, and walk through directory FDs rather than mutable paths.
    This runs once per broker boot, before the gateway starts work.
    """
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_uid not in (operator_uid, bot_uid):
            raise ValueError("workspace_has_foreign_owner")
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("workspace_has_symbolic_link")
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                migrate_tree(child, bot_uid, operator_uid, operator_gid)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            child = os.open(name, FD_FLAGS, dir_fd=fd)
            try:
                current = os.fstat(child)
                if (current.st_ino, current.st_dev, current.st_nlink, current.st_uid) != (info.st_ino, info.st_dev, 1, info.st_uid):
                    raise ValueError("workspace_changed_during_migration")
                os.fchown(child, bot_uid, bot_uid)
                # The operator may inspect the bot's own artifacts. Bots receive
                # no reciprocal access to the operator's private state.
                acl(child, f"u:{operator_uid}:rw-")
            finally:
                os.close(child)
        else:
            raise ValueError("workspace_has_link_or_special_file")
    os.fchown(fd, bot_uid, bot_uid)
    os.fchmod(fd, 0o700)
    acl(fd, f"u:{operator_uid}:rwx", f"u:{bot_uid}:rwx", "g::---", "o::---")
    acl(fd, f"u:{operator_uid}:rwx", f"u:{bot_uid}:rwx", "g::---", "o::---", default=True)


def tighten_private(fd, operator_uid, excluded=()):
    """Retain owner permissions and bytes, remove group/other access to native
    state that may predate the isolation upgrade. Never follow a linked path.
    """
    for name in os.listdir(fd):
        if name in excluded:
            continue
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_uid != operator_uid or stat.S_ISLNK(info.st_mode):
            continue
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                tighten_private(child, operator_uid)
                os.fchmod(child, stat.S_IMODE(info.st_mode) & 0o700)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            child = os.open(name, FD_FLAGS, dir_fd=fd)
            try:
                current = os.fstat(child)
                if current.st_uid == operator_uid and current.st_nlink == 1:
                    os.fchmod(child, stat.S_IMODE(current.st_mode) & 0o700)
            finally:
                os.close(child)


class Broker:
    def __init__(self):
        if sys.platform != "linux" or os.geteuid() != 0:
            raise RuntimeError("isolation_requires_linux_root_service")
        account = pwd.getpwnam("hermes")
        self.uid, self.gid = account.pw_uid, account.pw_gid
        if self.uid == 0:
            raise RuntimeError("operator_must_be_unprivileged")
        self.home = Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
        self.state = Path(os.environ.get("HOB_STATE_DIR", str(self.home / ".hob"))).resolve()
        if self.home == Path("/") or self.state == Path("/"):
            raise ValueError("invalid_isolation_home")
        self.home_fd = os.open(self.home, DIR_FLAGS)
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_fd = os.open(self.state, DIR_FLAGS)
        if os.fstat(self.state_fd).st_uid == 0:
            os.fchown(self.state_fd, self.uid, self.gid)
        PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = PRIVATE.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise ValueError("unsafe_isolation_volume")
        os.chmod(PRIVATE, 0o711)
        self.private_fd = os.open(PRIVATE, DIR_FLAGS)
        self.workspace_root_fd = directory_at(self.private_fd, 'workspaces', self.uid, self.gid)
        self.browser_root_fd = directory_at(self.private_fd, 'browsers', self.uid, self.gid)
        try:
            self.data = json.loads(read_regular(PRIVATE / "users.json", 0))
        except FileNotFoundError:
            if (self.state / "isolation-enabled").exists():
                raise ValueError("restore_missing_isolation_volume")
            self.data = {"version": 1, "bots": {}}
        if self.data.get("version") != 1 or not isinstance(self.data.get("bots"), dict) or len(self.data["bots"]) > 500:
            raise ValueError("invalid_isolation_registry")
        used = set()
        for name, record in self.data["bots"].items():
            profile_name(name)
            uid = record.get("uid")
            if type(uid) is not int or not 20000 <= uid < 60000 or uid == self.uid or uid in used:
                raise ValueError("invalid_isolation_user")
            used.add(uid)
        self.lock = threading.RLock()
        self.prepared = set()
        self.stopping = threading.Event()
        self.children = set()
        self.browsers = set()
        self.sshd = None
        # A broker restart must not leave old shells or Chrome processes running
        # beyond the new service's ownership. Tombstones revoke authorized keys.
        for row in self.data['bots'].values():
            self.kill_uid(row['uid'])
            if row.get('revoked'):
                with contextlib.suppress(FileNotFoundError):
                    (Path('/etc/hob-isolation/keys') / ('hob'+str(row['uid']))).unlink()
        # Native SSH uses this shared operator-only ControlMaster directory.
        # Reserve it before any isolated UID can pre-create it in /tmp.
        control = Path("/tmp/hermes-ssh")
        try:
            control.mkdir(mode=0o700)
            os.chown(control, self.uid, self.gid)
        except FileExistsError:
            info = control.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.uid:
                raise ValueError("unsafe_ssh_control_directory")
        os.chmod(control, 0o700)
        tighten_private(self.home_fd, self.uid, {"workspaces", self.state.name})
        tighten_private(self.state_fd, self.uid, {"browsers"})

    def save(self):
        atomic_at(self.private_fd, "users.json", (json.dumps(self.data) + "\n").encode(), 0, 0)

    def enrolled(self, name, *, revoked=False):
        try:
            data = json.loads(read_regular(self.state / "bots.json", self.uid))
        except FileNotFoundError:
            if name == "default" and not revoked:
                return
            raise ValueError("bot_not_enrolled")
        row = next((row for row in data.get("bots", []) if row.get("name") == name), None)
        if not row or (not revoked and row.get("state") not in ("active", "setup_required")):
            raise ValueError("bot_not_enrolled")

    def protect_parent(self, fd, uid):
        acl(fd, f"u:{uid}:--x")
        # A native 0644 create must not make profile credentials readable to an
        # isolated UID. Default named-user deny entries override other-read.
        acl(fd, f"u:{uid}:---", "g::---", "o::---", default=True)

    def copy_legacy(self, legacy, destination, uid, *, browser=False):
        try:
            source = os.open(legacy, DIR_FLAGS)
        except FileNotFoundError:
            return
        try:
            self.copy_tree(source, destination, uid, browser=browser)
        finally:
            os.close(source)

    def copy_tree(self, source, destination, uid, *, browser=False):
        # The old home stays intact. Every source is opened without following
        # links and revalidated; atomic FD-relative destinations cannot redirect
        # privileged writes outside the assigned data volume.
        for name in os.listdir(source):
            if browser and name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
                continue
            info = os.stat(name, dir_fd=source, follow_symlinks=False)
            if info.st_uid not in (self.uid, uid):
                raise ValueError('legacy_data_has_foreign_owner')
            if stat.S_ISDIR(info.st_mode):
                src = os.open(name, DIR_FLAGS, dir_fd=source)
                dest = directory_at(destination, name, self.uid, uid)
                try:
                    self.copy_tree(src, dest, uid, browser=browser)
                finally:
                    os.close(src)
                    os.close(dest)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                src = os.open(name, FD_FLAGS, dir_fd=source)
                temporary = '.hob-copy-' + os.urandom(16).hex()
                out = None
                try:
                    actual = os.fstat(src)
                    if (actual.st_ino, actual.st_dev, actual.st_nlink, actual.st_uid) != (info.st_ino, info.st_dev, 1, info.st_uid):
                        raise ValueError('legacy_data_changed_during_copy')
                    out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(actual.st_mode) & 0o700, dir_fd=destination)
                    os.fchown(out, self.uid, self.gid)
                    while True:
                        data = os.read(src, 1024 * 1024)
                        if not data:
                            break
                        while data:
                            written = os.write(out, data)
                            data = data[written:]
                    os.fsync(out)
                    os.rename(temporary, name, src_dir_fd=destination, dst_dir_fd=destination)
                finally:
                    os.close(src)
                    if out is not None:
                        os.close(out)
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(temporary, dir_fd=destination)
            else:
                raise ValueError('legacy_data_has_link_or_special_file')
        os.fsync(destination)

    def workspace(self, name, uid):
        workspace_fd = os.dup(self.workspace_root_fd)
        try:
            self.protect_parent(workspace_fd, uid)
            if name != "default":
                parent = directory_at(workspace_fd, "bots", self.uid, self.gid)
                os.close(workspace_fd)
                workspace_fd = parent
                self.protect_parent(workspace_fd, uid)
            leaf = "main" if name == "default" else name
            result = directory_at(workspace_fd, leaf, self.uid, uid)
            try:
                record = self.data['bots'][name]
                if not record.get('workspaceMigrated'):
                    legacy = self.home / 'workspaces' / ('main' if name == 'default' else 'bots/'+name)
                    self.copy_legacy(legacy, result, uid)
                    record['workspaceMigrated'] = True
                    self.save()
                migrate_tree(result, uid, self.uid, self.gid)
                hidden = directory_at(result, ".hob", uid, self.uid)
                try:
                    os.fchown(hidden, self.uid, self.gid)
                    acl(hidden, f"u:{uid}:r-x")
                    acl(hidden, f"u:{uid}:r-x", default=True)
                finally:
                    os.close(hidden)
            finally:
                os.close(result)
        finally:
            os.close(workspace_fd)
        return PRIVATE / "workspaces" / ("main" if name == "default" else "bots/" + name)

    def ensure(self, name):
        name = profile_name(name)
        with self.lock:
            self.enrolled(name)
            record = self.data["bots"].get(name)
            if record and record.get("revoked"):
                raise ValueError("bot_revoked")
            if not record:
                if len(self.data["bots"]) >= 500:
                    raise ValueError("isolation_user_limit")
                used = {r["uid"] for r in self.data["bots"].values()} | {r.pw_uid for r in pwd.getpwall()} | {r.gr_gid for r in grp.getgrall()} | {self.uid}
                uid = next(uid for uid in range(20000, 60000) if uid not in used)
                record = self.data["bots"][name] = {"uid": uid, "revoked": False}
                self.save()  # Reserve before creating an OS principal; never reuse.
            uid, username = record["uid"], "hob" + str(record["uid"])
            workspace = PRIVATE / "workspaces" / ("main" if name == "default" else "bots/" + name)
            if name not in self.prepared:
                try:
                    account = pwd.getpwnam(username)
                    if account.pw_uid != uid or account.pw_gid != uid:
                        raise ValueError("isolation_account_conflict")
                except KeyError:
                    # A previous interrupted setup may already have created the
                    # group. Reuse only its exact reserved identity.
                    try:
                        group = grp.getgrgid(uid)
                        if group.gr_name != username:
                            raise ValueError("isolation_group_conflict")
                    except KeyError:
                        run(["/usr/sbin/groupadd", "--gid", str(uid), username])
                    run(["/usr/sbin/useradd", "--uid", str(uid), "--gid", str(uid), "--no-create-home", "--home-dir", str(workspace), "--shell", "/bin/bash", "--password", "*", username])
                workspace = self.workspace(name, uid)
                self.install_key(name, username, uid)
                self.prepared.add(name)
                atomic_at(self.state_fd, "isolation-enabled", b"1\n", self.uid, self.gid)
            return {"version": 1, "profile": name, "uid": uid, "gid": uid, "user": username,
                    "workspace": str(workspace), "host": "127.0.0.1", "port": SSH_PORT,
                    "keyPath": str(self.state / "isolation-keys" / (name + ".key"))}

    def install_key(self, name, username, uid):
        key = PRIVATE / (username + ".key")
        if not key.exists():
            run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)])
        private = read_regular(key, 0, 16384)
        public = read_regular(str(key) + ".pub", 0, 16384)
        auth = Path("/etc/hob-isolation/keys")
        auth.mkdir(parents=True, mode=0o755, exist_ok=True)
        auth_fd = os.open(auth, DIR_FLAGS)
        try:
            atomic_at(auth_fd, username, public, 0, 0, 0o644)
        finally:
            os.close(auth_fd)
        keys = directory_at(self.state_fd, "isolation-keys", self.uid, self.gid)
        try:
            os.fchown(keys, self.uid, self.gid)
            os.fchmod(keys, 0o700)
            atomic_at(keys, name + ".key", private, self.uid, self.gid)
        finally:
            os.close(keys)

    def revoke(self, name):
        profile_name(name)
        with self.lock:
            self.enrolled(name, revoked=True)
            record = self.data["bots"].get(name)
            if not record:
                return {"revoked": True}
            record["revoked"] = True
            self.save()
            with contextlib.suppress(FileNotFoundError):
                (Path("/etc/hob-isolation/keys") / ("hob" + str(record["uid"]))).unlink()
            self.kill_uid(record["uid"])
            return {"revoked": True}

    def browser_profile(self, name, uid):
        registry = json.loads(read_regular(self.state / "browsers.json", self.uid))
        row = next((item for item in registry.get("browsers", []) if item.get("bot") == name), None)
        if not row:
            raise ValueError("browser_not_enrolled")
        parts = [name]
        if row.get("storageVersion") == 2:
            identity = row.get("browserProfileId")
            if not isinstance(identity, str) or re.fullmatch(r"br-[a-f0-9]{16}", identity) is None:
                raise ValueError("invalid_browser_identity")
            parts.append(identity)
        elif row.get("storageVersion") not in (None, 1):
            raise ValueError("invalid_browser_version")
        parts.append("chromium")
        parent = os.dup(self.browser_root_fd)
        self.protect_parent(parent, uid)
        try:
            for part in parts:
                child = directory_at(parent, part, self.uid, uid)
                os.close(parent)
                parent = child
                self.protect_parent(parent, uid)
            # Chromium's stale startup links must not be followed during an
            # ownership migration. Unlink only these known lock artifacts.
            for lock_name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(lock_name, dir_fd=parent)
            marker = self.data['bots'][name]
            identity = '/'.join(parts)
            if marker.get('browserMigrated') != identity:
                self.copy_legacy(self.state.joinpath('browsers', *parts), parent, uid, browser=True)
                marker['browserMigrated'] = identity
                self.save()
            migrate_tree(parent, uid, self.uid, self.gid)
        finally:
            os.close(parent)
        return PRIVATE.joinpath("browsers", *parts)

    def chromium(self, connection, request):
        name = profile_name(request.get("profile"))
        account = self.ensure(name)
        with self.lock:
            if name in self.browsers:
                raise ValueError("browser_already_running")
            directory = self.browser_profile(name, account["uid"])
            args = request.get("args")
            if not isinstance(args, list) or len(args) > 32 or not all(isinstance(arg, str) and len(arg) < 4096 for arg in args):
                raise ValueError("invalid_browser_arguments")
            for arg in args:
                if arg in BROWSER_FLAGS or re.fullmatch(r"--window-size=\d{2,5},\d{2,5}", arg):
                    continue
                if arg.startswith("--user-data-dir=") and Path(arg.split("=", 1)[1]).resolve() == directory:
                    continue
                raise ValueError("unsafe_browser_argument")
            if "--remote-debugging-pipe" not in args or not any(arg.startswith("--user-data-dir=") for arg in args):
                raise ValueError("private_browser_pipe_required")
            # Discovery is operator-owned, never a request-provided executable.
            chrome = read_regular("/etc/hob-isolation/chromium.path", 0, 4096).decode().strip()
            if not chrome or not Path(chrome).is_absolute() or not os.access(chrome, os.X_OK):
                raise ValueError("isolated_chromium_unavailable")
            image = Path(chrome).stat()
            if image.st_uid != 0 or image.st_mode & 0o022:
                raise ValueError("browser_executable_must_be_root_owned")
            self.browsers.add(name)
        read_command, write_command = os.pipe()
        read_reply, write_reply = os.pipe()
        # Avoid collisions with the conventional CDP descriptors 3/4 in the
        # unprivileged exec helper. No preexec_fn in this threaded service.
        command_fd = fcntl.fcntl(read_command, fcntl.F_DUPFD_CLOEXEC, 10)
        reply_fd = fcntl.fcntl(write_reply, fcntl.F_DUPFD_CLOEXEC, 10)
        os.close(read_command)
        os.close(write_reply)
        child = None
        try:
            environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": account["workspace"],
                           "LANG": "C.UTF-8", "TMPDIR": "/tmp"}
            child = subprocess.Popen([sys.executable, "-I", __file__, "--exec-browser", chrome, str(command_fd), str(reply_fd), json.dumps(args)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                pass_fds=(command_fd, reply_fd), user=account["uid"], group=account["gid"], extra_groups=[],
                env=environment, cwd=account["workspace"])
            os.close(command_fd)
            os.close(reply_fd)
            command_fd = reply_fd = None
            self.children.add(child)
            connection.sendall(json.dumps({"ok": True, "result": {"uid": account["uid"], "pid": child.pid}}).encode() + b"\n")
            connection.settimeout(None)
            poller = selectors.DefaultSelector()
            poller.register(connection, selectors.EVENT_READ, "command")
            poller.register(read_reply, selectors.EVENT_READ, "reply")
            try:
                while not self.stopping.is_set() and child.poll() is None:
                    for key, _ in poller.select(timeout=1):
                        if key.data == "command":
                            data = connection.recv(65536)
                            if not data:
                                return
                            while data:
                                count = os.write(write_command, data)
                                data = data[count:]
                        else:
                            data = os.read(read_reply, 65536)
                            if not data:
                                return
                            connection.sendall(data)
            finally:
                poller.close()
        finally:
            for fd in (command_fd, reply_fd, write_command, read_reply):
                if fd is not None:
                    with contextlib.suppress(OSError):
                        os.close(fd)
            if child:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                self.children.discard(child)
            with self.lock:
                self.browsers.discard(name)

    def kill_uid(self, uid):
        if uid == self.uid or uid < 20000:
            raise ValueError("refuse_operator_signal")
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                with contextlib.suppress(FileNotFoundError, ProcessLookupError, PermissionError):
                    pinned = os.pidfd_open(int(entry.name))
                    try:
                        text = (entry / "status").read_text()
                        actual = next(line for line in text.splitlines() if line.startswith("Uid:")).split()[1:]
                        if str(uid) in actual:
                            signal.pidfd_send_signal(pinned, signal.SIGKILL)
                    finally:
                        os.close(pinned)

    def start_ssh(self):
        host_key = PRIVATE / "ssh_host_ed25519_key"
        if not host_key.exists():
            run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(host_key)])
        public = read_regular(str(host_key) + ".pub", 0, 16384).decode().split()
        known_hosts = Path("/etc/ssh/ssh_known_hosts")
        expected = f"[127.0.0.1]:{SSH_PORT} {public[0]} {public[1]}"
        lines = known_hosts.read_text().splitlines() if known_hosts.exists() else []
        matches = [line for line in lines if line.startswith(f"[127.0.0.1]:{SSH_PORT} ")]
        if matches and matches != [expected]:
            raise ValueError("isolation_host_key_changed")
        if not matches:
            known_hosts.write_text("\n".join([*lines, expected]) + "\n")
        known_hosts.chmod(0o644)
        Path("/run/sshd").mkdir(mode=0o755, exist_ok=True)
        config = PRIVATE / "sshd_config"
        config.write_text(f"""Port {SSH_PORT}
ListenAddress 127.0.0.1
HostKey {host_key}
PidFile /run/hob-isolation/sshd.pid
AuthorizedKeysFile /etc/hob-isolation/keys/%u
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM no
AllowUsers hob*
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
X11Forwarding no
AcceptEnv *
Subsystem sftp internal-sftp
LogLevel ERROR
""")
        self.sshd = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)], stdin=subprocess.DEVNULL)

    def serve(self):
        run_dir = Path(SOCKET).parent
        run_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(run_dir, self.uid, self.gid)
        os.chmod(run_dir, 0o700)
        with contextlib.suppress(FileNotFoundError):
            Path(SOCKET).unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(SOCKET)
        os.chown(SOCKET, self.uid, self.gid)
        os.chmod(SOCKET, 0o600)
        server.listen(16)
        server.settimeout(1)
        self.start_ssh()
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: self.stopping.set())
        try:
            while not self.stopping.is_set():
                if self.sshd.poll() is not None:
                    raise RuntimeError("isolated_ssh_service_stopped")
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self.connection, args=(connection,), daemon=True).start()
        finally:
            self.stopping.set()
            server.close()
            if self.sshd:
                self.sshd.terminate()
            for record in self.data["bots"].values():
                self.kill_uid(record["uid"])

    def connection(self, connection):
        with connection:
            try:
                _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != self.uid:
                    raise PermissionError("operator_uid_required")
                connection.settimeout(30)
                data = bytearray()
                while not data.endswith(b"\n") and len(data) <= 16384:
                    chunk = connection.recv(1)
                    if not chunk:
                        return
                    data.extend(chunk)
                request = json.loads(data)
                if set(request) - {"version", "operation", "profile", "args"} or request.get("version") != 1:
                    raise ValueError("invalid_request")
                operation = request.get("operation")
                if operation == "chromium":
                    self.chromium(connection, request)
                    return
                if operation == "ensure":
                    result = self.ensure(request.get("profile"))
                elif operation == "revoke":
                    result = self.revoke(request.get("profile"))
                elif operation == "status":
                    result = {"version": 1, "ready": True, "operatorUid": self.uid}
                else:
                    raise ValueError("unsupported_operation")
                connection.sendall(json.dumps({"ok": True, "result": result}).encode() + b"\n")
            except Exception as exc:
                reason = str(exc) if isinstance(exc, (ValueError, PermissionError)) and re.fullmatch(r"[a-z_]+", str(exc)) else "isolation_operation_failed"
                with contextlib.suppress(OSError):
                    connection.sendall(json.dumps({"ok": False, "error": reason}).encode() + b"\n")


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "--exec-browser":
        # Already dropped by Popen(user=..., extra_groups=[]). This helper only
        # arranges inherited pipes; it has no privilege to grant or recover.
        if os.geteuid() == 0:
            raise SystemExit("refuse_root_browser")
        command, reply = int(sys.argv[3]), int(sys.argv[4])
        os.dup2(command, 3, inheritable=True)
        os.dup2(reply, 4, inheritable=True)
        os.close(command)
        os.close(reply)
        os.execv(sys.argv[2], [sys.argv[2], *json.loads(sys.argv[5])])
    if os.environ.get("HOB_ISOLATION") != "users":
        raise SystemExit("isolation_mode_not_enabled")
    Broker().serve()

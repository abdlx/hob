"""Revalidate native team shell/file environments at their execution owners.

The root broker proves the current per-bot principal. This does not qualify
arbitrary plugins, network spending, or public group execution.
"""
from functools import wraps
import json
from pathlib import Path
import socket
import struct
import sys
from types import SimpleNamespace

from agent import hob_team_context as context, hob_team_retention as retention


def _broker(profile):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect("/run/hob-isolation/broker.sock")
            _, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                raise ValueError("untrusted broker")
            client.sendall(json.dumps({"version": 1, "operation": "binding", "profile": profile}).encode() + b"\n")
            data = bytearray()
            while not data.endswith(b"\n") and len(data) <= 16384:
                chunk = client.recv(4096)
                if not chunk:
                    break
                data.extend(chunk)
            if not data.endswith(b"\n") or len(data) > 16384:
                raise ValueError("invalid response")
            reply = json.loads(data)
            if reply.get("ok") is not True or not isinstance(reply.get("result"), dict):
                raise ValueError("binding unavailable")
            return reply["result"]
    except (OSError, ValueError, AttributeError):
        raise context.TeamContextError("Per-bot OS isolation is unavailable; no local execution fallback is permitted.") from None


def _platform_supported():
    return sys.platform == "linux" and hasattr(socket, "SO_PEERCRED")


def authority():
    scope = retention._scope()
    if scope is None:
        return None
    if not _platform_supported():
        raise context.TeamContextError("Native team file and terminal execution requires Linux OS-user isolation.")
    binding = _broker(scope["profile"])
    state = context._state(SimpleNamespace(session_id=scope["session"]))
    if state is None or any(state[key] != scope[key] for key in ("authority", "profile", "kind")):
        raise context.TeamContextError("The bot's native execution authority changed.")
    expected_key = Path(scope["authority"]).parent / "isolation-keys" / (scope["profile"] + ".key")
    uid = binding.get("uid")
    if (set(binding) != {"version", "profile", "uid", "gid", "user", "workspace", "host", "port", "keyPath"}
            or type(binding["version"]) is not int or binding["version"] != 1 or binding["profile"] != scope["profile"]
            or type(uid) is not int or not 20000 <= uid < 60000 or type(binding["gid"]) is not int or binding["gid"] != uid
            or binding["user"] != "hob" + str(uid) or binding["host"] != "127.0.0.1"
            or type(binding["port"]) is not int or binding["port"] != 22220
            or binding["keyPath"] != str(expected_key)
            or binding["workspace"] != str(Path(state["metadata"]["workspace"]))):
        raise context.TeamContextError("The native execution binding does not match this bot's approved workspace and OS principal.")
    return scope, binding


def _stamp(proof):
    scope, binding = proof
    return (scope["authority"], scope["profile"], str(Path(scope["home"]).resolve()), tuple(sorted(binding.items())))


def _config(config, env_type, proof):
    if proof is None:
        return
    _, binding = proof
    if (env_type != "ssh" or config.get("env_type") != "ssh"
            or any(config.get(key) != value for key, value in {
                "ssh_host": binding["host"], "ssh_user": binding["user"], "ssh_port": binding["port"], "ssh_key": binding["keyPath"],
            }.items())):
        raise context.TeamContextError("Team execution must use this bot's broker-bound SSH backend; local and alternate backends are refused.")


def _environment(env, proof, *, newly_created=False):
    if proof is None:
        return env
    from tools.environments.ssh import SSHEnvironment
    _, binding = proof
    if (type(env) is not SSHEnvironment or any(getattr(env, key, None) != value for key, value in {
            "host": binding["host"], "user": binding["user"], "port": binding["port"], "key_path": binding["keyPath"],
        }.items())):
        raise context.TeamContextError("The cached execution environment belongs to another OS principal or backend.")
    marker = _stamp(proof)
    if newly_created:
        env._hob_team_isolation = marker
    elif getattr(env, "_hob_team_isolation", None) != marker:
        raise context.TeamContextError("Start a fresh native execution environment for this team bot.")
    return env


def factory(function):
    @wraps(function)
    def create(config, env_type, **kwargs):
        proof = authority()
        _config(config, env_type, proof)
        env = function(config, env_type, **kwargs)
        # Check revocation again after SSH bring-up, before returning an executor.
        current = authority() if proof is not None else None
        if proof is not None and (current is None or _stamp(current) != _stamp(proof)):
            raise context.TeamContextError("The bot's execution authority changed during SSH bring-up.")
        return _environment(env, current, newly_created=True)
    return create


def acquire(function):
    @wraps(function)
    def get(plan, task_id):
        proof = authority()
        _config(plan.config, plan.env_type, proof)
        return _environment(function(plan, task_id), proof)
    return get


def file_operations(function):
    @wraps(function)
    def get(*args, **kwargs):
        proof = authority()
        if proof is not None:
            from tools.terminal_tool import _get_env_config
            config = _get_env_config()
            _config(config, config["env_type"], proof)
        operations = function(*args, **kwargs)
        if proof is not None:
            _environment(operations.env, proof)
        return operations
    return get


def lazy_environment(function):
    @wraps(function)
    def get(*args, **kwargs):
        proof = authority()
        if proof is not None:
            from tools.terminal_tool import _get_env_config
            config = _get_env_config()
            _config(config, config["env_type"], proof)
        return _environment(function(*args, **kwargs), proof)
    return get

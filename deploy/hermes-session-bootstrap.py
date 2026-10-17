"""Private control-socket bootstrap for hob; never starts a second Gateway and never exports tickets to HTTP."""
import contextlib
import ipaddress
import json
import os
from pathlib import Path
import socket
import struct
import sys
from urllib.parse import urlsplit

# The gateway answers one JSON line per connection on a same-user private control
# socket. hob speaks that wire contract directly instead of importing the
# runtime's Python packages: the published image seals those modules, and a host
# application must not depend on one release's internal module layout. The
# contract itself is stable, documented, and already implemented by the shipped
# Desktop and TUI clients. Windows keeps the upstream helper because the pipe
# handshake needs SECURITY_SQOS flags that the standard library cannot set.
CONTROL_PROTOCOL = 1
SOCKET_NAME = "gateway.sock"
POINTER_NAME = "gateway.sock.path"
WS_PATH = "/api/ws"
WS_PROTOCOL = "hermes-gateway-v1"
TICKET_PREFIX = "hermes-gateway-ticket."
ATTACHABLE_STATES = frozenset({"ready", "draining"})
REQUIRED_CAPABILITY = "session-authority-v1"
TIMEOUT_SECONDS = 5.0
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 512 * 1024


def _canonical_home(home):
    return os.path.normcase(str(Path(home).expanduser().resolve(strict=False)))


def unix_socket_path(home):
    """Where this home publishes its control socket, or None when it publishes none."""
    direct = Path(home) / SOCKET_NAME
    if direct.exists():
        return direct
    with contextlib.suppress(OSError):
        pointer = Path(home) / POINTER_NAME
        target = pointer.read_text(encoding="utf-8-sig").strip() if pointer.is_file() else ""
        if target and Path(target).exists():
            return Path(target)
    return None


def _peer_uid(peer):
    """Listening process uid when the platform reports it, else None."""
    if not hasattr(socket, "SO_PEERCRED"):
        return None
    with contextlib.suppress(OSError):
        credentials = peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        return struct.unpack("3i", credentials)[0]
    return None


def _decode(data, request_id):
    response = json.loads(data.split(b"\n", 1)[0].decode("utf-8"))
    if (not isinstance(response, dict) or response.get("ok") is not True
            or response.get("protocol") != CONTROL_PROTOCOL or response.get("id") != request_id
            or not isinstance(response.get("result"), dict)):
        raise RuntimeError("invalid control response")
    return response["result"]


def call_unix(path, request):
    payload = json.dumps(request).encode("utf-8") + b"\n"
    if len(payload) > MAX_REQUEST_BYTES:
        raise ValueError("control request too large")
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        peer.settimeout(TIMEOUT_SECONDS)
        peer.connect(str(path))
        uid = _peer_uid(peer)
        if uid is not None and uid != os.getuid():
            raise PermissionError("control peer runs as another user")
        peer.sendall(payload)
        data = bytearray()
        while b"\n" not in data:
            chunk = peer.recv(4096)
            if not chunk:
                raise RuntimeError("incomplete control response")
            data.extend(chunk)
            if len(data) > MAX_RESPONSE_BYTES:
                raise RuntimeError("oversized control response")
    finally:
        peer.close()
    return _decode(bytes(data), request["id"])


def call_pipe(home, request):
    """Windows transport: the upstream helper, which sets the SQOS flags the pipe server needs."""
    sys.path.insert(0, os.environ["HERMES_DIR"])
    from pm.environments import activate_dependencies
    activate_dependencies(Path(os.environ["HERMES_DIR"]))
    from gateway.control_socket import windows_pipe_name
    from gateway.runtime_bootstrap_windows import query_runtime_control
    request_id = request["id"]
    raw = query_runtime_control(Path(home), json.dumps(request).encode("utf-8") + b"\n", TIMEOUT_SECONDS)
    return _decode(raw, request_id)


def call(home, request):
    path = unix_socket_path(home)
    if path is not None:
        return call_unix(path, request)
    if os.name == "nt":
        return call_pipe(home, request)
    raise FileNotFoundError("no gateway control socket for this home")


def _served_profile(payload, home):
    if type(payload.get("runtime_protocol")) is not int or payload["runtime_protocol"] != CONTROL_PROTOCOL:
        raise RuntimeError("runtime_protocol_mismatch")
    profiles = payload.get("served_profiles")
    wanted = _canonical_home(home)
    matches = [entry for entry in profiles if isinstance(entry, dict)
               and isinstance(entry.get("home"), str) and _canonical_home(entry["home"]) == wanted] if isinstance(profiles, list) else []
    if len(matches) != 1 or not isinstance(matches[0].get("profile_id"), str) or not matches[0]["profile_id"]:
        raise RuntimeError("profile_mismatch")
    state = payload.get("state")
    if state not in ATTACHABLE_STATES:
        raise RuntimeError("runtime_state_" + str(state))
    capabilities = payload.get("capabilities")
    if not isinstance(capabilities, list) or REQUIRED_CAPABILITY not in capabilities:
        raise RuntimeError("session_authority_unavailable")
    instance = payload.get("instance_id")
    if not isinstance(instance, str) or not instance:
        raise RuntimeError("invalid_runtime_identity")
    origin = payload.get("api_origin")
    try:
        parsed = urlsplit(origin)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
                or not parsed.port or not ipaddress.ip_address(parsed.hostname).is_loopback):
            raise ValueError
    except (TypeError, ValueError):
        raise RuntimeError("invalid_api_origin") from None
    return matches[0]["profile_id"], instance, origin


def ws_target(origin, ticket):
    return origin.replace("https:", "wss:").replace("http:", "ws:") + WS_PATH, [WS_PROTOCOL, TICKET_PREFIX + ticket]


def bootstrap():
    home = Path(os.environ["HERMES_HOME"]).resolve(strict=True)
    # An empty params object satisfies both the authenticated and the plain verb tables.
    endpoint = call(home, {"protocol": CONTROL_PROTOCOL, "verb": "identify", "id": 1, "params": {}})
    profile_id, instance_id, origin = _served_profile(endpoint, home)
    grant = call(home, {"protocol": CONTROL_PROTOCOL, "verb": "session-ticket", "id": 2, "params": {
        "profile_id": profile_id, "instance_id": instance_id, "purpose": "interactive"}})
    ticket = grant.get("ticket")
    if (not isinstance(ticket, str) or not ticket
            or grant.get("instance_id") not in (None, instance_id)
            or grant.get("profile_id") not in (None, profile_id)):
        raise RuntimeError("invalid session ticket")
    url, protocols = ws_target(origin, ticket)
    return {"url": url, "protocols": protocols, "profile_id": profile_id, "instance_id": instance_id}


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            grant = bootstrap()
        print(json.dumps(grant), flush=True)
    except Exception:
        # Child diagnostics can contain paths, configuration or tickets. The
        # Node parent also discards stderr and never relays execFile errors.
        print("session_owner_unavailable", file=sys.stderr)
        raise SystemExit(1)

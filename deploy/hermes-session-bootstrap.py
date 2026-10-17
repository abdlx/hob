"""Private pipe bootstrap for hob; never starts a second Gateway or exports tickets to HTTP."""
import contextlib
import json
import os
from pathlib import Path
import sys


def bootstrap():
    root = Path(os.environ["HERMES_DIR"]).resolve(strict=True)
    sys.path.insert(0, str(root))
    from pm.environments import activate_dependencies
    activate_dependencies(root)
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
    from hermes_cli.gateway_client import _session_ticket, gateway_ws_target
    home = Path(os.environ["HERMES_HOME"]).resolve(strict=True)
    result = discover_gateway_endpoint(home, timeout=5)
    if not attachable(result):
        raise RuntimeError("session_owner_unavailable")
    # Native discovery verifies the owner, served profile, loopback origin and
    # protocol. Native ticket minting verifies its OS peer and current instance.
    endpoint = result.endpoint
    ticket = _session_ticket(home, endpoint)
    url, protocols = gateway_ws_target(endpoint, ticket)
    return {"url": url, "protocols": protocols, "profile_id": endpoint.profile_id,
            "instance_id": endpoint.instance_id}


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

"""Unprivileged CDP pipe adapter to the private per-UID browser launcher."""
import json
import os
import selectors
import socket
import sys

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    client.settimeout(30)
    client.connect("/run/hob-isolation/broker.sock")
    client.sendall(json.dumps({"version": 1, "operation": "chromium", "profile": sys.argv[1], "args": json.loads(sys.argv[2])}).encode() + b"\n")
    line = bytearray()
    while not line.endswith(b"\n") and len(line) < 16384:
        chunk = client.recv(1)
        if not chunk:
            raise RuntimeError("isolated_browser_did_not_start")
        line.extend(chunk)
    receipt = json.loads(line)
    if receipt.get("ok") is not True:
        raise RuntimeError(receipt.get("error", "isolated_browser_unavailable"))
    client.settimeout(None)
    poller = selectors.DefaultSelector()
    poller.register(client, selectors.EVENT_READ, "reply")
    poller.register(3, selectors.EVENT_READ, "command")
    while True:
        for key, _ in poller.select():
            if key.data == "command":
                data = os.read(3, 65536)
                if not data:
                    raise SystemExit(0)
                client.sendall(data)
            else:
                data = client.recv(65536)
                if not data:
                    raise SystemExit(0)
                while data:
                    written = os.write(4, data)
                    data = data[written:]
except Exception:
    # Never echo request arguments, private paths or server responses to HTTP.
    print("isolated_browser_unavailable", file=sys.stderr)
    raise SystemExit(1)
finally:
    client.close()

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The Gateway control socket admits exactly one identity: the runtime user that
// owns it. struct ucred is (pid, uid, gid), so reading field 0 yields the peer's
// pid; comparing a pid against os.getuid() rejects every legitimate same-user
// peer and leaves the shipped image unable to attach to its own Gateway.
const probe = `
import importlib.util, socket, struct, sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hob_boot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Peer:
    def __init__(self, pid, uid, gid):
        self.credentials = struct.pack("3i", pid, uid, gid)

    def getsockopt(self, level, option, size):
        return self.credentials


class FailingPeer(Peer):
    def getsockopt(self, level, option, size):
        raise OSError("no peer credentials")


# The module reads the shared socket module, so this forces the Linux branch on
# every platform and keeps the assertion meaningful on the developer's machine.
socket.SO_PEERCRED = 17
assert module._peer_uid(Peer(4242, 10000, 10000)) == 10000, "the peer uid must be reported"
assert module._peer_uid(Peer(10000, 10000, 10000)) == 10000, "a coincidental pid must not be mistaken for authority"
assert module._peer_uid(FailingPeer(4242, 10000, 10000)) is None, "an unreadable peer identity must stay unknown"
print("ok")
`;

function interpreter() {
  for (const candidate of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* try the next interpreter */ }
  }
  return null;
}

test('the control-socket bootstrap reports the peer uid and never the peer pid', t => {
  const python = interpreter();
  if (!python) return t.skip('No Python interpreter is available for the native bootstrap.');
  const source = fileURLToPath(new URL('./hermes-session-bootstrap.py', import.meta.url));
  assert.equal(execFileSync(python, ['-c', probe, source], { encoding: 'utf8', timeout: 60000 }).trim(), 'ok');
});

// A multiplexing gateway owns ONE control socket at its launch home and serves every
// profile from it. A named bot has no socket in its own profile directory, so the
// bootstrap must dial HERMES_GATEWAY_HOME while binding the bot by HERMES_HOME.
const dialProbe = `
import importlib.util, os, sys, tempfile
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hob_boot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root = Path(tempfile.mkdtemp()).resolve()
home = root / "profiles" / "research"
home.mkdir(parents=True)
calls = []

def fake_call(socket_home, request):
    calls.append({"home": str(Path(socket_home).resolve()), "verb": request["verb"]})
    if request["verb"] == "identify":
        target = str(Path(os.environ["HERMES_HOME"]).resolve())
        return {"runtime_protocol": 1, "state": "ready", "capabilities": ["session-authority-v1"],
                "served_profiles": [{"profile_id": target, "home": target}],
                "instance_id": "synthetic-owner", "api_origin": "http://127.0.0.1:4455"}
    return {"ticket": "synthetic-ticket"}

module.call = fake_call
os.environ["HERMES_HOME"] = str(home)
os.environ["HERMES_GATEWAY_HOME"] = str(root)
grant = module.bootstrap()
assert [call["verb"] for call in calls] == ["identify", "session-ticket"], calls
assert all(call["home"] == str(root) for call in calls), calls
assert grant["profile_id"] == str(home), grant

calls.clear()
del os.environ["HERMES_GATEWAY_HOME"]
os.environ["HERMES_HOME"] = str(root)
module.bootstrap()
assert [call["home"] for call in calls] == [str(root), str(root)], calls
print("ok")
`;

test('the bootstrap dials the launch home and binds the requested profile home', t => {
  const python = interpreter();
  if (!python) return t.skip('No Python interpreter is available for the native bootstrap.');
  const source = fileURLToPath(new URL('./hermes-session-bootstrap.py', import.meta.url));
  assert.equal(execFileSync(python, ['-c', dialProbe, source], { encoding: 'utf8', timeout: 60000 }).trim(), 'ok');
});


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

"""Bounded native stack diagnostics for a disposable CI container only."""
import ast
import json
import os
from pathlib import Path
import re
import signal
import sys
import time


def main():
    root = Path('/proc')
    candidates = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if b'gateway' in args and b'run' in args and b'--no-supervise' in args:
                candidates.append(entry)
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            continue
    if len(candidates) != 1:
        print(json.dumps({'stack_probe': 'gateway_not_unique', 'count': len(candidates)}))
        return
    target = candidates[0]
    status = dict(line.split(':', 1) for line in (target / 'status').read_text().splitlines() if ':' in line)
    # Never send a signal with a default terminating disposition. The pinned
    # runtime registers SIGUSR2 with faulthandler, chain=False, during startup.
    if not int(status.get('SigCgt', '0').strip(), 16) & (1 << (signal.SIGUSR2 - 1)):
        print(json.dumps({'stack_probe': 'native_dump_hook_unavailable'}))
        return
    log = Path(os.environ.get('HERMES_HOME', '/opt/data')) / 'logs/gateway_faulthandler.log'
    offset = log.stat().st_size if log.exists() else 0
    os.kill(int(target.name), signal.SIGUSR2)
    for _ in range(20):
        if log.exists() and log.stat().st_size > offset:
            break
        time.sleep(0.1)
    frames = []
    if log.exists():
        with log.open('rb') as stream:
            stream.seek(offset)
            data = stream.read(48000).decode('utf-8', errors='replace')
        for line in data.splitlines():
            if line.startswith(('Thread ', 'Current thread ')):
                frames.append('thread')
            match = re.fullmatch(r'\s*File "(/opt/hermes/[^"\n]+)", line ([0-9]+) in ([\w.<>-]+)', line)
            if match:
                frames.append(match[1].removeprefix('/opt/hermes/') + ':' + match[2] + ':' + match[3])
    # Function/file names only: no source lines, frame locals, environment,
    # provider prompts, raw application logs, or credentials.
    print(json.dumps({'stack_probe': 'native_frames', 'frames': frames[:180]}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--lease-policy']:
        tree = ast.parse(Path('/opt/hermes/agent/turn_facade_lease.py').read_text())
        policy = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if name in {'LEASE_TTL_SECONDS', 'LEASE_WAIT_SECONDS'}:
                    policy[name] = ast.literal_eval(node.value)
        if set(policy) != {'LEASE_TTL_SECONDS', 'LEASE_WAIT_SECONDS'} or not 0 < policy['LEASE_TTL_SECONDS'] <= 600:
            raise RuntimeError('Unqualified native lease policy')
        print(json.dumps(policy))
    else:
        main()

"""Qualified hooks onto native delegation and the shared tool dispatch gate."""
import ast
import hashlib
import json
from pathlib import Path
import sys

SOURCES = {
    'agent/tool_executor.py': '3fb81cd7ec8946df1f6e50b0879b4be4499223b4236450da0581ac7c0a1727e6',
    'tools/delegate_tool_dispatch.py': 'd34a3e75abba19c628833b2e8b8d35f70ec0a522057d66e7feab1b1ae9511214',
}


def replace(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError('Coordinator hook differs from qualified Hermes source')
    return source.replace(before, after)


def revisions(source):
    out = dict(source)
    key = 'agent/tool_executor.py'
    before = '    block_message, block_error_type = scope_block, "tool_scope_block"\n'
    out[key] = replace(out[key], before,
        "    from agent import hob_coordinator\n    scope_block = scope_block or hob_coordinator.tool_block(agent, ref.name)\n" + before)
    key = 'tools/delegate_tool_dispatch.py'
    out[key] = replace(out[key], '    result = _execute_and_aggregate(batch)\n',
        "    from agent import hob_coordinator\n    if hob_coordinator.enabled(batch.parent_agent):\n        return hob_coordinator.refuse_inline(batch, reason)\n    result = _execute_and_aggregate(batch)\n")
    out[key] = replace(out[key], '    if background:\n        return _dispatch_background(batch)\n',
        "    from agent import hob_coordinator\n    if background or hob_coordinator.enabled(batch.parent_agent):\n        return _dispatch_background(batch)\n")
    out[key] = replace(out[key], '        inline_results.extend(_execute_and_aggregate(unit)["results"])\n',
        "        from agent import hob_coordinator\n        if hob_coordinator.enabled(batch.parent_agent):\n            inline_results.append(json.loads(hob_coordinator.refuse_inline(unit, 'scheduler_rejected')))\n        else:\n            inline_results.extend(_execute_and_aggregate(unit)[\"results\"])\n")
    for text in out.values():
        ast.parse(text)
    return out


def install(root):
    root = Path(root)
    sources = {}
    for relative, digest in SOURCES.items():
        target = root / relative
        if target.is_symlink() or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Coordinator source differs from qualified Hermes: ' + relative)
        sources[relative] = target.read_text(encoding='utf-8')
    helper = root / 'agent/hob_coordinator.py'
    if helper.exists() or helper.is_symlink():
        raise RuntimeError('Refusing to replace coordinator adapter')
    updated = revisions(sources)
    raw = Path(__file__).with_name('hob-coordinator.py').read_bytes()
    ast.parse(raw)
    for relative, text in updated.items():
        (root / relative).write_bytes(text.encode('utf-8'))
    helper.write_bytes(raw)
    helper.chmod(0o444)
    return {relative: hashlib.sha256(text.encode('utf-8')).hexdigest() for relative, text in updated.items()} | {'agent/hob_coordinator.py': hashlib.sha256(raw).hexdigest()}


if __name__ == '__main__':
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/hermes')
    digests = install(root)
    manifest = root / 'hob-compat.json'
    data = json.loads(manifest.read_text(encoding='utf-8'))
    data['coordinator_v1'] = digests
    manifest.write_text(json.dumps(data) + '\n', encoding='utf-8')
    manifest.chmod(0o444)

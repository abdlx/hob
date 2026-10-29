import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('qualified native browser evaluation keeps supplied CDP execution on its selected CLI page', async t => {
  try {
    await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./test-browser-eval-compat.py', import.meta.url))], { timeout: 15000, windowsHide: true });
  } catch (error) { if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; } throw error; }
});

test('qualified timezone cache follows saved profile changes, stays bounded and refuses unknown source', async t => {
  try {
    await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./test-timezone-compat.py', import.meta.url))], { timeout: 15000, windowsHide: true });
  } catch (error) { if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; } throw error; }
});

test('native controls mount only on qualified source and refuse repeated or unknown edits', async t => {
  const script = [
    'import ast, hashlib, importlib.util, tempfile',
    'from pathlib import Path',
    `spec=importlib.util.spec_from_file_location('compat', ${JSON.stringify(fileURLToPath(new URL('./apply-hermes-compat.py', import.meta.url)))})`,
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'with tempfile.TemporaryDirectory(prefix="hob-controls-") as root:',
    ' p=Path(root)/"skills.py"',
    ' source=b"from fastapi import APIRouter\\nrouter=APIRouter()\\n"',
    ' p.write_bytes(source)',
    ' expected=hashlib.sha256(source).hexdigest()',
    ' m.patch_controls(p, expected)',
    ' changed=p.read_bytes(); ast.parse(changed)',
    ' assert changed.decode().count("router.include_router(_hob_controls.router)") == 1',
    ' for content in [changed, source+b"# newer upstream\\n"]:',
    '  p.write_bytes(content)',
    '  try: m.patch_controls(p, expected)',
    '  except RuntimeError: pass',
    '  else: raise AssertionError("Unqualified source accepted")',
    '  assert p.read_bytes() == content',
    `ast.parse(Path(${JSON.stringify(fileURLToPath(new URL('./hob-native-controls.py', import.meta.url)))}).read_text(encoding="utf-8"))`,
  ].join('\n');
  try { await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { timeout: 15000, windowsHide: true }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; } throw error; }
});

test('native heartbeat compatibility fix preserves the legacy guard and refuses unknown or repeated source edits', async t => {
  const script = `import ast, hashlib, importlib.util, tempfile\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('compat', ${JSON.stringify(fileURLToPath(new URL('./apply-hermes-compat.py', import.meta.url)))})\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nwith tempfile.TemporaryDirectory(prefix='hob-compat-') as root:\n p=Path(root)/'run_goals.py'\n source='class Owner:\\n    async def poll(self, source, session_id, quick_key):\\n'+m.BEFORE\n p.write_bytes(source.encode('utf-8'))\n expected=hashlib.sha256(p.read_bytes()).hexdigest()\n m.patch_heartbeat(p, expected)\n changed=p.read_text()\n assert changed.count(m.AFTER)==1\n assert changed.index("if getattr(self, 'session_authority'") < changed.index('if not adapter._message_handler:')\n ast.parse(changed)\n before=p.read_bytes()\n try: m.patch_heartbeat(p, expected)\n except RuntimeError: pass\n else: raise AssertionError('repeated patch accepted')\n assert p.read_bytes()==before\n p.write_bytes((source+'# upstream changed\\n').encode('utf-8'))\n try: m.patch_heartbeat(p, expected)\n except RuntimeError: pass\n else: raise AssertionError('unknown upstream accepted')\nprint('compatibility checks passed')`;
  try {
    const result = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { timeout: 15000, windowsHide: true });
    assert.match(result.stdout, /compatibility checks passed/);
  } catch (error) { if (error.code === 'ENOENT') { t.skip('Python unavailable'); return; } throw error; }
});

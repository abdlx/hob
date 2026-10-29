"""Qualified compatibility extensions for the digest-pinned Hermes runtime.

7e9eb8d9's native LOCAL adapter intentionally has no legacy message handler.
run_goals incorrectly checks that handler before its native-authority branch,
so a saved dashboard heartbeat never reaches native admission. Keep the legacy
guard on the legacy path; retain native ownership, provenance and FIFO checks.
Unknown source content fails the image build instead of applying a fuzzy patch.
The skills router also mounts profile-scoped review and schedule-preview JSON
controls, delegating writes and schedule parsing to the native owners.
The native clock cache includes the resolved profile timezone so an explicit
timezone change is visible without restarting every bot; cache growth is bounded.
Supplied CDP endpoints keep console evaluation on the native CLI's selected page,
instead of the optional supervisor's independently attached launch page.
"""
import ast
import hashlib
import os
from pathlib import Path
import sys

SOURCE_SHA256 = "20770e785884c3c4f8f8d246d566070882f42a896cebd333a7d22dadbd8fbebf"
SKILLS_SHA256 = "77f304a13486d8273b5aa437ca0dd2573c2d071472d1284390d34858df96e39e"
TIME_SHA256 = "9c8ba38f50bdf0b8d2a3a96dfe471f0c7b29ec3e83f96596624d258119a0b19e"
BROWSER_SHA256 = "b8a5929440b7efcebc187212ce47a7ce14c148f4c734e09e14bf9b0855cc39b4"
TIME_IDENTITY_BEFORE = '''def _timezone_cache_identity() -> tuple[str, str]:
    tz_env = _env_timezone()
    return ("environment", tz_env) if tz_env else ("config", str(get_config_path()))
'''
TIME_IDENTITY_AFTER = '''def _timezone_cache_identity() -> tuple[str, ...]:
    tz_env = _env_timezone()
    return ("environment", tz_env) if tz_env else ("config", str(get_config_path()), _resolve_timezone_name())
'''
TIME_CACHE_BEFORE = '''        return _tz_cache.setdefault(cache_identity, (name, tz))'''
TIME_CACHE_AFTER = '''        if len(_tz_cache) >= 256 and cache_identity not in _tz_cache:
            _tz_cache.pop(next(iter(_tz_cache)))
        return _tz_cache.setdefault(cache_identity, (name, tz))'''
CONTROLS_REGISTRATION = '''
# hob: qualified, profile-scoped native JSON controls.
import importlib.util as _hob_import
_hob_spec = _hob_import.spec_from_file_location("hob_native_controls", "/app/deploy/hob-native-controls.py")
_hob_controls = _hob_import.module_from_spec(_hob_spec)
_hob_spec.loader.exec_module(_hob_controls)
router.include_router(_hob_controls.router)
'''
BEFORE = """        adapter = self._delivery_adapter_for(source)
        if adapter is None or not adapter._message_handler:
            return
        if getattr(self, 'session_authority', None) is not None:
            from gateway.run_heartbeat_acceptance import admit_heartbeat
            await admit_heartbeat(self, adapter, source, session_id, quick_key)
            return
"""
AFTER = """        adapter = self._delivery_adapter_for(source)
        if adapter is None:
            return
        if getattr(self, 'session_authority', None) is not None:
            from gateway.run_heartbeat_acceptance import admit_heartbeat
            await admit_heartbeat(self, adapter, source, session_id, quick_key)
            return
        if not adapter._message_handler:
            return
"""


def patch_controls(filename, expected=SKILLS_SHA256):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file():
        raise RuntimeError("Expected the pinned Hermes skills router")
    original = filename.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected:
        raise RuntimeError("Hermes skills router differs from the qualified upstream commit")
    revised = original.decode("utf-8") + CONTROLS_REGISTRATION
    ast.parse(revised)
    filename.write_text(revised, encoding="utf-8")
    return hashlib.sha256(revised.encode("utf-8")).hexdigest()


def patch_timezone(filename, expected=TIME_SHA256):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file():
        raise RuntimeError("Expected the pinned Hermes clock")
    original = filename.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected:
        raise RuntimeError("Hermes clock differs from the qualified upstream commit")
    revised = original.decode("utf-8")
    for before, after in [
        (TIME_IDENTITY_BEFORE, TIME_IDENTITY_AFTER),
        ('_tz_cache: dict[tuple[str, str],', '_tz_cache: dict[tuple[str, ...],'),
        ('    name = _resolve_timezone_name()\n', '    name = cache_identity[-1]\n'),
        (TIME_CACHE_BEFORE, TIME_CACHE_AFTER),
    ]:
        if revised.count(before) != 1:
            raise RuntimeError("Expected one qualified clock-cache site")
        revised = revised.replace(before, after)
    ast.parse(revised)
    filename.write_bytes(revised.encode("utf-8"))
    return hashlib.sha256(revised.encode("utf-8")).hexdigest()


def patch_heartbeat(filename, expected=SOURCE_SHA256):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file():
        raise RuntimeError("Expected the pinned Hermes heartbeat source file")
    original = filename.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected:
        raise RuntimeError("Hermes heartbeat source differs from the qualified upstream commit")
    text = original.decode("utf-8")
    if text.count(BEFORE) != 1:
        raise RuntimeError("Expected exactly one native heartbeat compatibility site")
    revised = text.replace(BEFORE, AFTER)
    ast.parse(revised)
    filename.write_bytes(revised.encode("utf-8"))
    return hashlib.sha256(revised.encode("utf-8")).hexdigest()


def patch_browser_eval(filename, expected=BROWSER_SHA256):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file():
        raise RuntimeError("Expected the pinned Hermes browser tool")
    original = filename.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected:
        raise RuntimeError("Hermes browser tool differs from the qualified upstream commit")
    text = original.decode("utf-8")
    functions = [node for node in ast.parse(text).body if isinstance(node, ast.FunctionDef) and node.name == "_eval_supervisor_fast_path"]
    if len(functions) != 1 or ast.get_docstring(functions[0]) is None:
        raise RuntimeError("Expected one qualified native browser evaluation site")
    lines = text.splitlines(keepends=True)
    lines.insert(functions[0].body[0].end_lineno, '''    # hob: a supplied CDP connection's selected page belongs to agent-browser.
    # The supervisor independently attaches to the first page (often New Tab).
    # Keep evaluation on the same native CLI session as navigate/type/click.
    if _cdp._get_cdp_override_raw():
        return None
''')
    revised = "".join(lines)
    ast.parse(revised)
    filename.write_bytes(revised.encode("utf-8"))
    return hashlib.sha256(revised.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes")
    digest = patch_heartbeat(root / "gateway/run_goals.py")
    controls_digest = patch_controls(root / "hermes_cli/web_routers/skills.py")
    timezone_digest = patch_timezone(root / "hermes_time.py")
    browser_digest = patch_browser_eval(root / "tools/browser_tool.py")
    manifest = root / "hob-compat.json"
    manifest.write_text('{"upstream":"7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357","patch":"native-local-heartbeat-v1","sha256":"' + digest + '","controls_sha256":"' + controls_digest + '","timezone_sha256":"' + timezone_digest + '","browser_eval_sha256":"' + browser_digest + '"}\n')
    os.chmod(manifest, 0o444)
    print("Applied pinned native-local-heartbeat-v1 compatibility fix (" + digest + ")")

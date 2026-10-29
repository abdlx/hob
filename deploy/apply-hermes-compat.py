"""Qualified compatibility extensions for the digest-pinned Hermes runtime.

7e9eb8d9's native LOCAL adapter intentionally has no legacy message handler.
run_goals incorrectly checks that handler before its native-authority branch,
so a saved dashboard heartbeat never reaches native admission. Keep the legacy
guard on the legacy path; retain native ownership, provenance and FIFO checks.
Unknown source content fails the image build instead of applying a fuzzy patch.
The skills router also mounts profile-scoped review and schedule-preview JSON
controls, delegating writes and schedule parsing to the native owners.
"""
import ast
import hashlib
import os
from pathlib import Path
import sys

SOURCE_SHA256 = "20770e785884c3c4f8f8d246d566070882f42a896cebd333a7d22dadbd8fbebf"
SKILLS_SHA256 = "77f304a13486d8273b5aa437ca0dd2573c2d071472d1284390d34858df96e39e"
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


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes")
    digest = patch_heartbeat(root / "gateway/run_goals.py")
    controls_digest = patch_controls(root / "hermes_cli/web_routers/skills.py")
    manifest = root / "hob-compat.json"
    manifest.write_text('{"upstream":"7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357","patch":"native-local-heartbeat-v1","sha256":"' + digest + '","controls_sha256":"' + controls_digest + '"}\n')
    os.chmod(manifest, 0o444)
    print("Applied pinned native-local-heartbeat-v1 compatibility fix (" + digest + ")")

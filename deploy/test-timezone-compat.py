"""Regression for the qualified native cache fix; no clock service or network."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("compat", Path(__file__).with_name("apply-hermes-compat.py"))
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)


class TimezoneCompatibility(unittest.TestCase):
    def test_updates_are_visible_without_restart_and_cache_stays_bounded(self):
        source = '''from typing import Optional
import threading
ZoneInfo = str
_tz_cache: dict[tuple[str, str], tuple[str, Optional[ZoneInfo]]] = {}
_cache_lock = threading.Lock()
context = {"profile": "one", "zone": "UTC"}
def get_config_path(): return context["profile"]
def _env_timezone(): return ""
def _resolve_timezone_name(): return context["zone"]
''' + compat.TIME_IDENTITY_BEFORE + '''
def entry():
    cache_identity = _timezone_cache_identity()
    with _cache_lock:
        if cache_identity in _tz_cache:
            return _tz_cache[cache_identity]
    name = _resolve_timezone_name()
    tz = name
    with _cache_lock:
''' + compat.TIME_CACHE_BEFORE + "\n"
        namespace = {}
        exec(compile(source, "native-clock-fixture", "exec"), namespace)
        self.assertEqual(namespace["entry"]()[0], "UTC")
        namespace["context"]["zone"] = "Asia/Karachi"
        self.assertEqual(namespace["entry"]()[0], "UTC", "The baseline must reproduce the stale native cache")
        with tempfile.TemporaryDirectory(prefix="hob-clock-") as temporary:
            filename = Path(temporary) / "hermes_time.py"
            original = source.encode("utf-8")
            filename.write_bytes(original)
            expected = hashlib.sha256(original).hexdigest()
            compat.patch_timezone(filename, expected)
            changed = filename.read_bytes()
            fixed = {}
            exec(compile(changed, "qualified-clock-fixture", "exec"), fixed)
            self.assertEqual(fixed["entry"]()[0], "UTC")
            fixed["context"]["zone"] = "Asia/Karachi"
            self.assertEqual(fixed["entry"]()[0], "Asia/Karachi")
            fixed["context"].update(profile="two", zone="America/New_York")
            self.assertEqual(fixed["entry"]()[0], "America/New_York")
            for index in range(300):
                fixed["context"]["zone"] = f"fixture-zone-{index}"
                fixed["entry"]()
            self.assertLessEqual(len(fixed["_tz_cache"]), 256)
            fixed["_env_timezone"] = lambda: "UTC"
            self.assertEqual(fixed["entry"]()[0], "UTC")
            for content in [changed, original + b"# unknown upstream\n"]:
                filename.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    compat.patch_timezone(filename, expected)
                self.assertEqual(filename.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()

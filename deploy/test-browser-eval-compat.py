"""Qualify selected-page dispatch without starting models or borrowing runtime owners."""
import hashlib
import importlib.util
import tempfile
import types
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("compat", Path(__file__).with_name("apply-hermes-compat.py"))
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)
SOURCE = '''def _eval_supervisor_fast_path(task, expression):
    """Optional observer optimization; the CLI owns a supplied CDP page."""
    return {"success": True, "result": "chrome://new-tab-page/"}
'''


class BrowserDispatchTests(unittest.TestCase):
    def test_supplied_cdp_uses_the_native_cli_while_local_fast_path_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="hob-browser-eval-") as directory:
            filename = Path(directory) / "browser_tool.py"
            filename.write_bytes(SOURCE.encode())
            context = {"_cdp": types.SimpleNamespace(_get_cdp_override_raw=lambda: "owned-cdp")}
            exec(SOURCE, context)
            self.assertEqual(context["_eval_supervisor_fast_path"]("bot-task", "location.href")["result"], "chrome://new-tab-page/")
            compat.patch_browser_eval(filename, hashlib.sha256(SOURCE.encode()).hexdigest())
            exec(filename.read_text(encoding="utf-8"), context)
            # None is the native caller's existing CLI fallthrough contract.
            self.assertIsNone(context["_eval_supervisor_fast_path"]("bot-task", "location.href"))
            context["_cdp"]._get_cdp_override_raw = lambda: None
            self.assertEqual(context["_eval_supervisor_fast_path"]("bot-task", "location.href")["result"], "chrome://new-tab-page/")

    def test_unknown_or_repeated_source_is_refused_without_rewriting_it(self):
        with tempfile.TemporaryDirectory(prefix="hob-browser-eval-") as directory:
            filename = Path(directory) / "browser_tool.py"
            expected = hashlib.sha256(SOURCE.encode()).hexdigest()
            filename.write_bytes(SOURCE.encode())
            compat.patch_browser_eval(filename, expected)
            for content in [filename.read_bytes(), SOURCE.encode() + b"# unqualified change\n"]:
                filename.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    compat.patch_browser_eval(filename, expected)
                self.assertEqual(filename.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()

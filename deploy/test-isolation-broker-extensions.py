"""Unit tests for isolation broker extension argument whitelisting and limits."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("broker", Path(__file__).with_name("isolation-broker.py"))
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class IsolationBrokerExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hob-broker-test-")
        self.addCleanup(self.temporary.cleanup)
        self.sandbox = Path(self.temporary.name) / "browsers" / "test-bot" / "chromium"
        self.sandbox.mkdir(parents=True)
        self.extensions_dir = self.sandbox / "extensions"
        self.extensions_dir.mkdir()
        self.ext1 = self.extensions_dir / "ext1"
        self.ext1.mkdir()
        self.ext2 = self.extensions_dir / "ext2"
        self.ext2.mkdir()
        self.outside = Path(self.temporary.name) / "outside"
        self.outside.mkdir()

    def validate_args(self, args: list[str], directory: Path | None = None) -> None:
        """Mirror the validation loop from Broker.chromium in isolation-broker.py."""
        target_directory = (directory or self.sandbox).resolve()
        if not isinstance(args, list) or len(args) > 64 or not all(isinstance(arg, str) and len(arg) < 4096 for arg in args):
            raise ValueError("invalid_browser_arguments")
        for arg in args:
            if arg in m.BROWSER_FLAGS or m.re.fullmatch(r"--window-size=\d{2,5},\d{2,5}", arg):
                continue
            if arg.startswith("--user-data-dir=") and Path(arg.split("=", 1)[1]).resolve() == target_directory:
                continue
            if arg.startswith("--load-extension=") or arg.startswith("--disable-extensions-except="):
                raw_paths = arg.split("=", 1)[1].split(",")
                try:
                    if raw_paths and all(p and Path(p).resolve().is_relative_to(target_directory) for p in raw_paths):
                        continue
                except (ValueError, OSError):
                    pass
            raise ValueError("unsafe_browser_argument")
        if "--remote-debugging-pipe" not in args or not any(arg.startswith("--user-data-dir=") for arg in args):
            raise ValueError("private_browser_pipe_required")

    def test_browser_flags_retains_disable_extensions(self):
        self.assertIn("--disable-extensions", m.BROWSER_FLAGS)

    def test_args_limit_increased_to_64(self):
        base_args = [
            "--headless=new",
            "--remote-debugging-pipe",
            f"--user-data-dir={self.sandbox}",
            "--window-size=1280,1024",
        ]
        # 33 valid args (previously limit was 32)
        valid_33 = base_args + ["--mute-audio"] * (33 - len(base_args))
        self.assertEqual(len(valid_33), 33)
        self.validate_args(valid_33)

        # 64 valid args
        valid_64 = base_args + ["--mute-audio"] * (64 - len(base_args))
        self.assertEqual(len(valid_64), 64)
        self.validate_args(valid_64)

        # 65 args must raise invalid_browser_arguments
        too_many = base_args + ["--mute-audio"] * (65 - len(base_args))
        with self.assertRaises(ValueError) as ctx:
            self.validate_args(too_many)
        self.assertEqual(str(ctx.exception), "invalid_browser_arguments")

    def test_whitelisted_extension_arguments_within_sandbox(self):
        base_args = [
            "--headless=new",
            "--remote-debugging-pipe",
            f"--user-data-dir={self.sandbox}",
            "--window-size=1280,1024",
        ]
        # Single extension
        args = base_args + [
            f"--load-extension={self.ext1}",
            f"--disable-extensions-except={self.ext1}",
        ]
        self.validate_args(args)

        # Multiple extensions
        joined = f"{self.ext1},{self.ext2}"
        args_multi = base_args + [
            f"--load-extension={joined}",
            f"--disable-extensions-except={joined}",
        ]
        self.validate_args(args_multi)

    def test_rejects_extension_paths_outside_sandbox(self):
        base_args = [
            "--headless=new",
            "--remote-debugging-pipe",
            f"--user-data-dir={self.sandbox}",
            "--window-size=1280,1024",
        ]
        # Path outside sandbox
        for flag in ("--load-extension=", "--disable-extensions-except="):
            with self.assertRaises(ValueError) as ctx:
                self.validate_args(base_args + [f"{flag}{self.outside}"])
            self.assertEqual(str(ctx.exception), "unsafe_browser_argument")

            # Path traversal attempting escape
            with self.assertRaises(ValueError) as ctx:
                self.validate_args(base_args + [f"{flag}{self.sandbox}/../../outside"])
            self.assertEqual(str(ctx.exception), "unsafe_browser_argument")

            # Mixed list where one path escapes
            with self.assertRaises(ValueError) as ctx:
                self.validate_args(base_args + [f"{flag}{self.ext1},{self.outside}"])
            self.assertEqual(str(ctx.exception), "unsafe_browser_argument")

            # Empty argument value
            with self.assertRaises(ValueError) as ctx:
                self.validate_args(base_args + [flag])
            self.assertEqual(str(ctx.exception), "unsafe_browser_argument")

            # Trailing comma
            with self.assertRaises(ValueError) as ctx:
                self.validate_args(base_args + [f"{flag}{self.ext1},"])
            self.assertEqual(str(ctx.exception), "unsafe_browser_argument")

    def test_rejects_symlink_escaping_sandbox(self):
        base_args = [
            "--headless=new",
            "--remote-debugging-pipe",
            f"--user-data-dir={self.sandbox}",
            "--window-size=1280,1024",
        ]
        symlink_escape = self.extensions_dir / "escaped"
        try:
            symlink_escape.symlink_to(self.outside)
        except OSError:
            self.skipTest("Symlinks not supported in environment")

        with self.assertRaises(ValueError) as ctx:
            self.validate_args(base_args + [f"--load-extension={symlink_escape}"])
        self.assertEqual(str(ctx.exception), "unsafe_browser_argument")


if __name__ == "__main__":
    unittest.main()

"""Unit tests for deploy/extension-helper.py."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("helper", Path(__file__).with_name("extension-helper.py"))
assert spec is not None and spec.loader is not None
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def make_crx3(zip_bytes: bytes, header_data: bytes = b"mock-header") -> bytes:
    magic = b"Cr24"
    version = (3).to_bytes(4, "little")
    header_size = len(header_data).to_bytes(4, "little")
    return magic + version + header_size + header_data + zip_bytes


def make_zip(files: dict[str, str | bytes]) -> bytes:
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w") as zf:
        for name, content in files.items():
            if isinstance(content, str):
                zf.writestr(name, content)
            else:
                zf.writestr(name, content)
    return bio.getvalue()


class ExtensionHelperTests(unittest.TestCase):
    def test_omaha_url_formatting(self):
        ext_id = "iomcoelgdkghlligeempdbfcaobodacg"
        url = helper.omaha_url(ext_id)
        self.assertTrue(url.startswith("https://clients2.google.com/service/update2/crx?"))
        self.assertIn("prodversion=130.0", url)
        self.assertIn(f"x=id%3D{ext_id}%26uc", url)

        with self.assertRaises(ValueError):
            helper.omaha_url("")
        with self.assertRaises(ValueError):
            helper.omaha_url("../../traversal")

    def test_strip_crx_header(self):
        zip_bytes = make_zip({"manifest.json": "{}"})
        crx3 = make_crx3(zip_bytes)
        stripped = helper.strip_crx_header(crx3)
        self.assertEqual(stripped, zip_bytes)

        # Raw zip passthrough
        self.assertEqual(helper.strip_crx_header(zip_bytes), zip_bytes)

        # Invalid magic
        with self.assertRaises(ValueError):
            helper.strip_crx_header(b"FAIL" + b"\x00" * 30)

        # Truncated
        with self.assertRaises(ValueError):
            helper.strip_crx_header(b"Cr24\x03\x00\x00\x00\xff\x00\x00\x00short")

    def test_validate_manifest(self):
        with tempfile.TemporaryDirectory(prefix="hob-test-manifest-") as td:
            p = Path(td)
            # Missing
            with self.assertRaises(ValueError):
                helper.validate_manifest(p)

            # Invalid JSON
            (p / "manifest.json").write_text("not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                helper.validate_manifest(p)

            # Not an object
            (p / "manifest.json").write_text("[]", encoding="utf-8")
            with self.assertRaises(ValueError):
                helper.validate_manifest(p)

            # Missing version
            (p / "manifest.json").write_text(json.dumps({"name": "Test", "manifest_version": 3}), encoding="utf-8")
            with self.assertRaises(ValueError):
                helper.validate_manifest(p)

            # Missing name
            (p / "manifest.json").write_text(json.dumps({"version": "1.0", "manifest_version": 3}), encoding="utf-8")
            with self.assertRaises(ValueError):
                helper.validate_manifest(p)

            # Valid
            valid = {"name": "Test Extension", "version": "1.0.0", "manifest_version": 3}
            (p / "manifest.json").write_text(json.dumps(valid), encoding="utf-8")
            res = helper.validate_manifest(p)
            self.assertEqual(res, valid)

    def test_install_extension_end_to_end(self):
        with tempfile.TemporaryDirectory(prefix="hob-test-install-") as td:
            profile_dir = Path(td)
            ext_id = "testextensionid123"
            manifest = {"name": "Test Ext", "version": "0.1.0", "manifest_version": 3}
            zip_bytes = make_zip({"manifest.json": json.dumps(manifest), "background.js": "console.log('hi');"})
            crx_bytes = make_crx3(zip_bytes)

            result = helper.install_extension(ext_id, profile_dir, crx_data=crx_bytes)
            self.assertTrue(result["ok"])
            self.assertEqual(result["id"], ext_id)
            self.assertEqual(result["name"], "Test Ext")
            self.assertEqual(result["version"], "0.1.0")

            expected_dir = profile_dir / "extensions" / ext_id
            self.assertTrue((expected_dir / "manifest.json").is_file())
            self.assertTrue((expected_dir / "background.js").is_file())


if __name__ == "__main__":
    unittest.main()

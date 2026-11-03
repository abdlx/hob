#!/usr/bin/env python3
"""Chrome extension helper for HOB.

Downloads CRX3 packages via Omaha (prodversion=130.0), strips the CRX3 header,
unzips to <profileDir>/extensions/<id>, and validates manifest.json.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request
import zipfile

OMAHA_URL = "https://clients2.google.com/service/update2/crx"
OMAHA_PRODVERSION = "130.0"
EXTENSION_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}\Z")


def omaha_url(extension_id: str, prodversion: str = OMAHA_PRODVERSION) -> str:
    if not EXTENSION_ID_PATTERN.fullmatch(extension_id):
        raise ValueError(f"invalid_extension_id:{extension_id}")
    params = urllib.parse.urlencode({
        "response": "redirect",
        "prodversion": prodversion,
        "acceptformat": "crx2,crx3",
        "x": f"id={extension_id}&uc",
    })
    return f"{OMAHA_URL}?{params}"


def download_crx(extension_id: str, prodversion: str = OMAHA_PRODVERSION) -> bytes:
    url = omaha_url(extension_id, prodversion)
    req = urllib.request.Request(url, headers={"User-Agent": "HOB-Extension-Helper/1.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"omaha_download_failed:HTTP_{response.status}")
        return response.read()


def strip_crx_header(data: bytes) -> bytes:
    if len(data) < 16:
        raise ValueError("crx_buffer_too_small")
    if data[:2] == b"PK":
        return data
    if data[:4] != b"Cr24":
        raise ValueError("invalid_crx_magic")
    version = int.from_bytes(data[4:8], "little")
    if version == 3:
        header_size = int.from_bytes(data[8:12], "little")
        zip_offset = 12 + header_size
    elif version == 2:
        key_size = int.from_bytes(data[8:12], "little")
        sig_size = int.from_bytes(data[12:16], "little")
        zip_offset = 16 + key_size + sig_size
    else:
        raise ValueError(f"unsupported_crx_version:{version}")

    if zip_offset > len(data):
        raise ValueError("crx_header_truncated")
    zip_data = data[zip_offset:]
    if len(zip_data) < 4 or zip_data[:2] != b"PK":
        raise ValueError("invalid_zip_signature_in_crx")
    return zip_data


def unzip_extension(zip_data: bytes, target_dir: Path) -> None:
    target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
        for member in zf.infolist():
            filename = member.filename
            if filename.startswith("/") or ".." in filename.split("/"):
                raise ValueError(f"unsafe_zip_entry:{filename}")
        zf.extractall(target_dir)


def validate_manifest(target_dir: Path) -> dict:
    manifest_file = target_dir / "manifest.json"
    if not manifest_file.is_file():
        raise ValueError("missing_manifest_json")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("invalid_manifest_json") from exc

    if not isinstance(manifest, dict):
        raise ValueError("manifest_not_an_object")
    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        raise ValueError("missing_or_empty_manifest_name")
    if not isinstance(manifest.get("version"), str) or not manifest["version"].strip():
        raise ValueError("missing_or_empty_manifest_version")
    if not isinstance(manifest.get("manifest_version"), int) or manifest["manifest_version"] < 2:
        raise ValueError("invalid_manifest_version")
    return manifest


def install_extension(extension_id: str, profile_dir: str | Path, *, crx_data: bytes | None = None) -> dict:
    if not EXTENSION_ID_PATTERN.fullmatch(extension_id):
        raise ValueError(f"invalid_extension_id:{extension_id}")
    profile = Path(profile_dir).resolve()
    target_dir = profile / "extensions" / extension_id.lower()

    data = crx_data if crx_data is not None else download_crx(extension_id)
    zip_data = strip_crx_header(data)
    unzip_extension(zip_data, target_dir)
    manifest = validate_manifest(target_dir)
    return {
        "ok": True,
        "id": extension_id.lower(),
        "targetDir": str(target_dir),
        "name": manifest.get("name"),
        "version": manifest.get("version"),
        "manifestVersion": manifest.get("manifest_version"),
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extension-helper.py <extension_id> <profile_dir>", file=sys.stderr)
        sys.exit(1)
    try:
        res = install_extension(sys.argv[1], sys.argv[2])
        print(json.dumps(res, indent=2))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
